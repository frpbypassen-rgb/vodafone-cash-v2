# Optional merchant API IP allowlist

Company and agency owners can manage up to 20 exact IPv4/IPv6 addresses from the API page. Addresses are the merchant server's outbound public/NAT IPs, not the owner's phone IP and not Ahram Pay's server IP. URLs, hostnames, CIDR ranges, ports, scoped IPv6 addresses, and ambiguous IPv4 forms are rejected. IPv6 compression and IPv4-mapped IPv6 are normalized before comparison.

The policy defaults to disabled, including on historical accounts. Saving requires the owner's current password, CSRF validation, and the current integration revision. An enabled empty list is rejected. Stale saves return 409. The shared integration snapshot exposes the saved state to administration; administrative API/Webhooks flag edits preserve the IP policy. Changes are audited without tokens or passwords.

An enabled policy is enforced in merchant authentication for balance, transfer creation, and status reads. A valid token from an unlisted address returns HTTP 403 with `IP_NOT_ALLOWED` before transfer validation, wallet debits, or queue dispatch. Missing/invalid tokens still fail authentication. Portal login/settings remain accessible, allowing an owner to correct the list. Already authenticated in-flight financial requests are not cancelled.

## Reverse proxies and IIS/ARR

IP enforcement reads the TCP peer. It follows `X-Forwarded-For` only when Express `trust proxy` names explicit trusted addresses/networks, and follows the chain from right to left until the nearest untrusted peer. It ignores spoofed forwarding headers on untrusted direct connections. Numeric hop counts and trust-all are insufficient when clients may reach port 3000 directly. If such an ambiguous configuration accompanies a forwarding header, address resolution fails closed; enabling via the portal is rejected with `PROXY_CONFIGURATION_REQUIRED` before any settings are changed.

Before enabling behind IIS/ARR, an operator must verify the real proxy chain and confirm its forwarding-header append/overwrite behavior. For a **verified** IIS proxy on the same host, `TRUST_PROXY=loopback` is an example; remote proxies require their explicit addresses or narrow networks. Do not use broad private networks or trust-all as a shortcut. This implementation does not change the live environment or perform a production restart/cutover.

Reference: [Express reverse-proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

## Verification

53 tests passed across seven focused suites, covering exact IP parsing, mapped addresses, empty/invalid policies, real company/agency authentication, spoofed headers, trusted chains, direct access, password/CSRF, tenant and owner boundaries, revision conflicts, administrative synchronization, token rotation/revocation, and unchanged financial balances/transaction counts on denied requests.

An ephemeral in-memory UI fixture verified empty-list rejection, invalid-input errors, password clearing, IPv4/IPv6 editing, enable/disable, and management while API access is administratively disabled. Mobile widths 320/390 and desktop width 1366 were inspected with day/night themes. The actual local account was opened for review without enabling a policy or inserting guessed addresses.
