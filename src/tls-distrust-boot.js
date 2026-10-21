// Side-effect import: installs the distrusted-intermediate TLS refusal for the
// whole process (see tls-distrust.js). Import it first in an entry point.
import { installTlsDistrust } from "./tls-distrust.js";
installTlsDistrust();
