<?php
/**
 * Plugin Name:       Agent402 Tollbooth
 * Plugin URI:        https://agent402.tools/tollbooth
 * Description:       Open-source pay-per-crawl gate for WordPress. Charge AI crawlers per request (USDC via x402, or a free CPU proof-of-work) while humans browse free. Mirrors the agent402-tollbooth npm package for non-Node sites.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Mikey Petrillo
 * Author URI:        https://github.com/MikeyPetrillo
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       agent402-tollbooth
 *
 * The classifier here is intentionally a faithful PHP port of
 * tollbooth/bots.js + tollbooth/index.js shouldCharge(): same default UA
 * list, same modes, same observe semantics, same stats vocabulary. That
 * way an agency running mixed WP + Node clients sees one consistent
 * dashboard.
 *
 * Free rail (proof-of-work) and paid rail (USDC via x402) require an
 * external verifier — pure PHP can't reuse the JS HMAC/replay store. Set
 * "Verifier URL" in the settings page to point at the Cloudflare Worker
 * template at tollbooth/deploy/cloudflare; the plugin then forwards
 * candidate headers and trusts the verifier's pass/fail. Until you
 * configure that, the gate runs as a pure observe-or-block — which is
 * still the right starting point per the recommended rollout.
 */

if (!defined('ABSPATH')) { exit; }

class Agent402_Tollbooth {

    const OPT_KEY        = 'agent402_tollbooth_options';
    const STATS_KEY      = 'agent402_tollbooth_stats';
    const VERSION        = '0.1.0';
    const NONCE_ACTION   = 'agent402_tollbooth_save';
    const ADMIN_SLUG     = 'agent402-tollbooth';

    /** Mirrors tollbooth/bots.js AI_BOTS exactly. Update both together. */
    const AI_BOTS = [
        'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
        'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'Claude-User',
        'PerplexityBot', 'Perplexity-User',
        'CCBot', 'Bytespider', 'Google-Extended', 'Amazonbot',
        'cohere-ai', 'Meta-ExternalAgent', 'Meta-ExternalFetcher',
        'Applebot-Extended', 'Diffbot', 'Omgilibot', 'ImagesiftBot',
        'YouBot', 'Timpibot', 'DuckAssistBot', 'PetalBot',
        'FriendlyCrawler', 'AI2Bot', 'Scrapy', 'python-requests',
    ];

    public static function defaults() {
        return [
            'mode'         => 'observe',     // observe | bots | all | strict
            'pay_to'       => '',            // 0x... Base wallet
            'price'        => '$0.002',
            'network'      => 'base',
            'verifier_url' => '',            // Worker URL for PoW/x402 verification
            'site_id'      => parse_url(home_url(), PHP_URL_HOST) ?: 'wordpress',
            'enabled'      => '1',
        ];
    }

    public static function init() {
        register_activation_hook(__FILE__, [__CLASS__, 'on_activate']);
        register_deactivation_hook(__FILE__, [__CLASS__, 'on_deactivate']);

        // Hook the gate as early as possible — before WP routes are dispatched
        // and (importantly) before any heavy plugin bootstraps. We can't go
        // earlier than 'init' without forfeiting access to wp_remote_post.
        add_action('init', [__CLASS__, 'gate'], 0);

        add_action('admin_menu',  [__CLASS__, 'admin_menu']);
        add_action('admin_init',  [__CLASS__, 'admin_init']);
        add_action('admin_post_agent402_tollbooth_reset', [__CLASS__, 'admin_reset_stats']);
    }

    public static function on_activate() {
        if (get_option(self::OPT_KEY) === false) {
            update_option(self::OPT_KEY, self::defaults(), false);
        }
        if (get_option(self::STATS_KEY) === false) {
            update_option(self::STATS_KEY, self::zero_stats(), false);
        }
    }

    public static function on_deactivate() { /* keep options for re-activation */ }

    private static function zero_stats() {
        return [
            'requests'      => 0,
            'freeAllowed'   => 0,
            'wouldCharge'   => 0,   // observe-mode only
            'charged'       => 0,   // sent 402
            'powSolved'     => 0,
            'x402Paid'      => 0,
            'lastReset'     => time(),
        ];
    }

    private static function opts() {
        $o = get_option(self::OPT_KEY, []);
        return is_array($o) ? array_merge(self::defaults(), $o) : self::defaults();
    }

    private static function bump($key, $n = 1) {
        $s = get_option(self::STATS_KEY, self::zero_stats());
        if (!isset($s[$key])) { $s[$key] = 0; }
        $s[$key] += $n;
        update_option(self::STATS_KEY, $s, false);
    }

    /** Mirrors tollbooth/index.js looksHuman() — browser UA + HTML Accept. */
    private static function looks_human($ua, $accept) {
        return preg_match('#mozilla/5\.0#i', $ua) && stripos($accept, 'text/html') !== false;
    }

    /** Mirrors tollbooth/bots.js makeBotMatcher() — case-insensitive substring. */
    private static function is_known_bot($ua) {
        if (!$ua) return false;
        $needle = strtolower($ua);
        foreach (self::AI_BOTS as $b) {
            if (strpos($needle, strtolower($b)) !== false) return true;
        }
        return false;
    }

    private static function should_charge($mode, $ua, $accept) {
        if ($mode === 'all')    return true;
        if ($mode === 'strict') return !self::looks_human($ua, $accept);
        return self::is_known_bot($ua); // 'bots' (default) and observe
    }

    /** Skip the gate for admin, WP-CLI, cron, and the WordPress login/admin paths. */
    private static function should_skip() {
        if (defined('WP_CLI') && WP_CLI) return true;
        if (defined('DOING_CRON') && DOING_CRON) return true;
        if (defined('REST_REQUEST') && REST_REQUEST) return false; // gate REST too
        if (is_admin()) return true;
        $uri = $_SERVER['REQUEST_URI'] ?? '';
        if (strpos($uri, '/wp-admin') === 0) return true;
        if (strpos($uri, '/wp-login.php') === 0) return true;
        return false;
    }

    public static function gate() {
        $opts = self::opts();
        if (empty($opts['enabled'])) return;
        if (self::should_skip()) return;

        $ua     = $_SERVER['HTTP_USER_AGENT'] ?? '';
        $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
        $mode   = $opts['mode'];

        self::bump('requests');

        if (!self::should_charge($mode === 'observe' ? 'bots' : $mode, $ua, $accept)) {
            self::bump('freeAllowed');
            return;
        }

        // Observe-only: classify, count, never 402. Run for 7-14 days before
        // flipping enforcement on — same recommendation as the Node version.
        if ($mode === 'observe') {
            self::bump('wouldCharge');
            header('X-Tollbooth-Observed: would-charge');
            return;
        }

        // Free rail (proof-of-work). Verified by an external worker because
        // pure PHP can't share the JS HMAC + single-use replay store. Without
        // a configured verifier, fall through to send 402.
        $pow_header = $_SERVER['HTTP_X_POW_SOLUTION'] ?? '';
        if ($pow_header && !empty($opts['verifier_url'])) {
            if (self::verify_with_worker($opts['verifier_url'], 'pow', $pow_header)) {
                self::bump('powSolved');
                header('X-Tollbooth-Paid: pow');
                return;
            }
        }

        // Paid rail (x402 USDC). Same delegated verification model.
        $pay_header = $_SERVER['HTTP_X_PAYMENT'] ?? ($_SERVER['HTTP_PAYMENT_SIGNATURE'] ?? '');
        if (!empty($opts['pay_to']) && $pay_header && !empty($opts['verifier_url'])) {
            if (self::verify_with_worker($opts['verifier_url'], 'x402', $pay_header, $opts['pay_to'], $opts['price'], $opts['network'])) {
                self::bump('x402Paid');
                header('X-Tollbooth-Paid: x402');
                return;
            }
        }

        self::bump('charged');
        self::send_402($opts);
        exit;
    }

    /**
     * Delegate verification to a configured Worker. We POST a JSON envelope
     * the Worker can verify with its own HMAC secret / x402 facilitator, and
     * trust the boolean answer. Conservative: any error = fail = 402.
     */
    private static function verify_with_worker($url, $kind, $token, $payTo = '', $price = '', $network = '') {
        $body = json_encode([
            'kind'     => $kind,
            'token'    => $token,
            'resource' => self::canonical_resource(),
            'payTo'    => $payTo,
            'price'    => $price,
            'network'  => $network,
        ]);
        $resp = wp_remote_post($url, [
            'timeout'     => 8,
            'headers'     => ['Content-Type' => 'application/json'],
            'body'        => $body,
            'data_format' => 'body',
            'redirection' => 0,
        ]);
        if (is_wp_error($resp)) return false;
        if (wp_remote_retrieve_response_code($resp) !== 200) return false;
        $j = json_decode(wp_remote_retrieve_body($resp), true);
        return is_array($j) && !empty($j['ok']);
    }

    private static function canonical_resource() {
        $scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host   = $_SERVER['HTTP_HOST'] ?? parse_url(home_url(), PHP_URL_HOST);
        $uri    = $_SERVER['REQUEST_URI'] ?? '/';
        return $scheme . '://' . $host . $uri;
    }

    private static function send_402($opts) {
        $resource = self::canonical_resource();
        $body = [
            'error'   => 'Payment Required',
            'message' => 'This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.',
            'accepts' => empty($opts['pay_to']) ? [] : [[
                'scheme'             => 'exact',
                'network'            => $opts['network'] ?: 'base',
                'maxAmountRequired'  => $opts['price']   ?: '$0.001',
                'asset'              => 'USDC',
                'payTo'              => $opts['pay_to'],
                'resource'           => $resource,
            ]],
            'note'    => empty($opts['verifier_url'])
                ? 'Proof-of-work and x402 verification require a configured verifier URL. See plugin settings.'
                : 'POST X-Pow-Solution or X-Payment header; the gate will verify and retry.',
        ];
        nocache_headers();
        status_header(402, 'Payment Required');
        header('Content-Type: application/json');
        echo wp_json_encode($body);
    }

    public static function admin_menu() {
        add_options_page(
            'Agent402 Tollbooth',
            'Agent402 Tollbooth',
            'manage_options',
            self::ADMIN_SLUG,
            [__CLASS__, 'render_admin_page']
        );
    }

    public static function admin_init() {
        register_setting(self::ADMIN_SLUG, self::OPT_KEY, [
            'type'              => 'array',
            'sanitize_callback' => [__CLASS__, 'sanitize_opts'],
            'default'           => self::defaults(),
        ]);
    }

    public static function sanitize_opts($input) {
        $cur = self::opts();
        $out = $cur;

        $modes = ['observe', 'bots', 'all', 'strict'];
        $out['mode']         = in_array(($input['mode'] ?? ''), $modes, true) ? $input['mode'] : $cur['mode'];
        $out['pay_to']       = preg_replace('/[^0-9a-zA-Zx]/', '', $input['pay_to'] ?? '');
        $out['price']        = preg_replace('/[^0-9.$]/', '', $input['price'] ?? '');
        $out['network']      = in_array(($input['network'] ?? ''), ['base', 'base-sepolia', 'polygon', 'arbitrum'], true) ? $input['network'] : 'base';
        $out['verifier_url'] = esc_url_raw($input['verifier_url'] ?? '');
        $out['site_id']      = sanitize_text_field($input['site_id'] ?? $cur['site_id']);
        $out['enabled']      = !empty($input['enabled']) ? '1' : '0';
        return $out;
    }

    public static function admin_reset_stats() {
        if (!current_user_can('manage_options')) wp_die('forbidden');
        check_admin_referer('agent402_tollbooth_reset');
        update_option(self::STATS_KEY, self::zero_stats(), false);
        wp_safe_redirect(admin_url('options-general.php?page=' . self::ADMIN_SLUG . '&reset=1'));
        exit;
    }

    public static function render_admin_page() {
        if (!current_user_can('manage_options')) return;
        $opts  = self::opts();
        $stats = get_option(self::STATS_KEY, self::zero_stats());
        $since = human_time_diff($stats['lastReset'], time());
        $reset_url = wp_nonce_url(
            admin_url('admin-post.php?action=agent402_tollbooth_reset'),
            'agent402_tollbooth_reset'
        );
        ?>
        <div class="wrap">
          <h1>Agent402 Tollbooth</h1>
          <p>
            Pay-per-crawl for this site. Charge AI crawlers per request (USDC via x402, or a free CPU proof-of-work) while humans browse free.
            <a href="https://agent402.tools/tollbooth" target="_blank" rel="noopener">Docs</a> ·
            <a href="https://agent402.tools/tollbooth/cloud" target="_blank" rel="noopener">Cloud (multi-site dashboard)</a>
          </p>

          <?php if (!empty($_GET['settings-updated'])): ?>
            <div class="notice notice-success is-dismissible"><p>Settings saved.</p></div>
          <?php endif; ?>
          <?php if (!empty($_GET['reset'])): ?>
            <div class="notice notice-success is-dismissible"><p>Stats reset.</p></div>
          <?php endif; ?>

          <h2>Stats <small style="color:#666;">(since <?php echo esc_html($since); ?> ago)</small></h2>
          <table class="widefat striped" style="max-width:680px;">
            <tbody>
              <tr><th>Requests seen</th><td><?php echo (int)$stats['requests']; ?></td></tr>
              <tr><th>Free-allowed (humans / non-bot)</th><td><?php echo (int)$stats['freeAllowed']; ?></td></tr>
              <tr><th>Would-charge (observe mode)</th><td><?php echo (int)$stats['wouldCharge']; ?></td></tr>
              <tr><th>Sent 402 (charged)</th><td><?php echo (int)$stats['charged']; ?></td></tr>
              <tr><th>Solved proof-of-work</th><td><?php echo (int)$stats['powSolved']; ?></td></tr>
              <tr><th>Paid in USDC (x402)</th><td><?php echo (int)$stats['x402Paid']; ?></td></tr>
            </tbody>
          </table>
          <p><a class="button" href="<?php echo esc_url($reset_url); ?>">Reset stats</a></p>

          <h2 style="margin-top:32px;">Settings</h2>
          <form method="post" action="options.php">
            <?php settings_fields(self::ADMIN_SLUG); ?>
            <table class="form-table" role="presentation">
              <tr>
                <th><label for="att-enabled">Enabled</label></th>
                <td>
                  <input type="checkbox" id="att-enabled" name="<?php echo esc_attr(self::OPT_KEY); ?>[enabled]" value="1" <?php checked($opts['enabled'], '1'); ?>>
                  <label for="att-enabled">Run the gate on every public request</label>
                </td>
              </tr>
              <tr>
                <th><label for="att-mode">Mode</label></th>
                <td>
                  <select id="att-mode" name="<?php echo esc_attr(self::OPT_KEY); ?>[mode]">
                    <option value="observe" <?php selected($opts['mode'],'observe'); ?>>observe — classify only, never 402 (recommended first)</option>
                    <option value="bots"    <?php selected($opts['mode'],'bots');    ?>>bots — charge known AI crawler UAs</option>
                    <option value="all"     <?php selected($opts['mode'],'all');     ?>>all — charge everything except an explicit allow</option>
                    <option value="strict"  <?php selected($opts['mode'],'strict');  ?>>strict — charge anything that doesn't look like a real browser</option>
                  </select>
                  <p class="description">Run <code>observe</code> for 7-14 days. Watch the stats fill in. Flip to <code>bots</code> when the numbers look right.</p>
                </td>
              </tr>
              <tr>
                <th><label for="att-pay-to">USDC wallet (Base)</label></th>
                <td>
                  <input type="text" id="att-pay-to" class="regular-text code" name="<?php echo esc_attr(self::OPT_KEY); ?>[pay_to]" value="<?php echo esc_attr($opts['pay_to']); ?>" placeholder="0x…">
                  <p class="description">Your own wallet. Settled funds go direct from the bot to this address — Agent402 never touches the money.</p>
                </td>
              </tr>
              <tr>
                <th><label for="att-price">Price per request</label></th>
                <td>
                  <input type="text" id="att-price" class="regular-text code" name="<?php echo esc_attr(self::OPT_KEY); ?>[price]" value="<?php echo esc_attr($opts['price']); ?>" placeholder="$0.002">
                </td>
              </tr>
              <tr>
                <th><label for="att-network">Network</label></th>
                <td>
                  <select id="att-network" name="<?php echo esc_attr(self::OPT_KEY); ?>[network]">
                    <option value="base"          <?php selected($opts['network'],'base');         ?>>base</option>
                    <option value="base-sepolia"  <?php selected($opts['network'],'base-sepolia'); ?>>base-sepolia (testnet)</option>
                    <option value="polygon"       <?php selected($opts['network'],'polygon');      ?>>polygon</option>
                    <option value="arbitrum"      <?php selected($opts['network'],'arbitrum');     ?>>arbitrum</option>
                  </select>
                </td>
              </tr>
              <tr>
                <th><label for="att-verifier">Verifier URL</label></th>
                <td>
                  <input type="url" id="att-verifier" class="regular-text code" name="<?php echo esc_attr(self::OPT_KEY); ?>[verifier_url]" value="<?php echo esc_attr($opts['verifier_url']); ?>" placeholder="https://tollbooth.your-domain.com/verify">
                  <p class="description">
                    Optional. Point at a deployed <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare" target="_blank" rel="noopener">Cloudflare Worker</a> (or any HTTP service) that knows how to verify proof-of-work tokens and x402 settlements. Without it the plugin runs as a pure observe-or-block gate — fine for AI-training-deterrent use, but the free PoW rail and the paid USDC rail need this.
                  </p>
                </td>
              </tr>
              <tr>
                <th><label for="att-site-id">Site ID</label></th>
                <td>
                  <input type="text" id="att-site-id" class="regular-text code" name="<?php echo esc_attr(self::OPT_KEY); ?>[site_id]" value="<?php echo esc_attr($opts['site_id']); ?>">
                  <p class="description">Tag this site uses when reporting stats to a multi-site dashboard. Defaults to your domain.</p>
                </td>
              </tr>
            </table>
            <?php submit_button(); ?>
          </form>

          <p style="margin-top:32px; color:#666;">
            Plugin version <?php echo esc_html(self::VERSION); ?> ·
            <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress" target="_blank" rel="noopener">source</a> ·
            <a href="https://github.com/MikeyPetrillo/Agent402/issues" target="_blank" rel="noopener">report an issue</a>
          </p>
        </div>
        <?php
    }
}

Agent402_Tollbooth::init();
