# Security

This is a personal website. If you find a security problem (for example in the
Worker in `src/worker.js` or the analytics proxy), please report it privately via
[GitHub's private vulnerability reporting](https://github.com/avguchenko/anton.miami/security/advisories/new)
rather than opening a public issue.

Note: the PostHog key in `public/ab/track.js` is a public, write-only project key by design
(it ships to every browser); it is not a secret.
