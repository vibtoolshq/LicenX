# Frequently asked questions

### Is LicenX a payment checkout platform?

No payment gateway or built-in checkout flow was established in the inspected source. The **Buy License** button follows a configured URL.

### Do I need the administrator account to check my license?

No for the public status page, unless the administrator disables that action. PIN-controlled device management requires the license key **and** PIN.

### Is a quick license check read-only?

It does not bind a device, but the implementation can mark an expired license as expired. The separate restricted external tool membership check is designed to avoid changing license/device status.

### Why is the tools page empty?

Only saved **enabled** tools are shown. A zero-item published catalog shows the documented empty state.

### Can the Python SDK work offline indefinitely?

No. Its policy is tied to signed authorization, last trusted lease, heartbeat timing and configured grace. A retained login hint is not permission for unverified operations.

### Is production backup recovery guaranteed because the job completed?

No. Recovery depends on preserving the off-server recovery key and validating decryption/restoration in an isolated environment.

### Does `MEMORY.md` automatically share conversations across IDEs?

No. `MEMORY.md` and `.ai-rules` are Git-tracked written context; native IDE instructions tell agents to read/update them. Synchronize authorized repository commits between IDE workspaces.

### What is the supported Python SDK?

`licenx` in `SDK/client/python/licenx/`. Old `x_license_python` references in historic notes do not describe a maintained source tree in this snapshot.

[Start here](getting-started.md) · [Support troubleshooting](troubleshooting.md).