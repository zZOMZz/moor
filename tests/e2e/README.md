# End-to-end validation

Deterministic Electron checks are implemented by `scripts/validation/check-*.cjs`
and use disposable profiles plus synthetic accounts, projects and Agents. Real-account,
multi-device, system-permission, sleep/wake and Developer ID/notarization status remains
documented in `docs/validation.md`; those checks are never inferred from synthetic tests.
