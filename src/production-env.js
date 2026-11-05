// One reading of "this boot is production", shared by the guards that act
// differently there (the backup alarm word, the trust-proxy boot warning).
// Production is the image's NODE_ENV=production (the Dockerfile sets it) or the
// platform's own environment name, which Railway sets on every deployment
// whatever the image does; never a FREE_MODE boot.
export function isProductionEnv(env = process.env) {
  if (env.FREE_MODE === "true") return false;
  return env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME === "production" || env.RAILWAY_ENVIRONMENT === "production";
}
