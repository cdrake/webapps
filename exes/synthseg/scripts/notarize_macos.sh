#!/bin/sh
# Notarize, staple and validate a signed installer package.
#
#   notarize_macos.sh FILE.pkg [KEYCHAIN_PROFILE]
set -eu
set -o pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pkg=${1:?usage: notarize_macos.sh FILE.pkg [KEYCHAIN_PROFILE]}
profile=${2:-synthseg-notary}
[ -f "$pkg" ] || { echo "notarize_macos.sh: file not found: $pkg" >&2; exit 2; }
# pkgutil exits successfully for an unsigned package, so inspect its status too.
signature=$(pkgutil --check-signature "$pkg" 2>&1) || {
	echo "$signature" >&2; exit 2; }
case "$signature" in
*"Status: signed by a developer certificate"*) ;;
*) echo "notarize_macos.sh: $pkg is unsigned or invalid. Set MACOS_INSTALLER_IDENTITY and run 'make macos-pkg'." >&2; exit 2;;
esac
# stapler fetches the ticket from Apple's CloudKit, which sometimes drops the connection
# (NSURLErrorDomain -1005, exit 68) after notarization has succeeded; retry it a few times.
stapler() {
	attempt=1
	until xcrun stapler "$@"; do
		[ "$attempt" -lt 4 ] || return 1
		sleep $((attempt * ${STAPLER_RETRY_SECONDS:-20}))
		attempt=$((attempt + 1))
	done
}
xcrun notarytool submit "$pkg" --keychain-profile "$profile" --wait
stapler staple "$pkg"
# Every validation below must pass (set -e); its output is kept beside the artifact as release evidence.
log="$pkg.validation.txt"
{
	date -u +"%Y-%m-%dT%H:%M:%SZ notarize_macos.sh $pkg"
	stapler validate "$pkg"
	pkgutil --check-signature "$pkg"
	"$root/scripts/verify_macos_pkg.sh" "$pkg"
	# Installer packages are assessed under the "install" policy; "open" is for applications.
	spctl --assess --type install --verbose=4 "$pkg" 2>&1
	shasum -a 256 "$pkg" | tee "$pkg.sha256"
} | tee "$log"
echo "Notarized, stapled and Gatekeeper-validated $pkg (evidence: $log)"
