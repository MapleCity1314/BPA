# BPA Console Host

The Console Host is a short-lived, loopback-only HTTP boundary for the BPA
Operator Console. It does not import Local Core, access SQLite, or accept local
filesystem paths.

## Integration

The default executable creates `UdsControlBackend` over
`@bpa/control-client`. It uses `BPA_SOCKET` when set, otherwise resolves
`BPA_HOME/run/core.sock` through the shared client.

```ts
const handle = await startConsoleHost({
  backend,
  staticRoot: "/absolute/path/to/operator-console/dist"
});

open(handle.launchUrl);
```

`launchUrl` contains a one-time token in the URL fragment. The web application
exchanges it for an HttpOnly, SameSite=Strict cookie and a CSRF token. The token
is invalid after the first exchange. Sessions expire after 30 minutes of idle
time.

Set `BPA_CONSOLE_ACCESS_MODE=viewer` to create a fail-closed read-only session.
Viewer sessions can use authenticated GET projections, while every business
mutation is rejected by the HTTP server and hidden by the web application.
Browser and recovery bindings plus technical details are stripped, action task
lists are empty, and file bodies remain unavailable until a remote identity can
be authorized against their classification.
This mode does not make the host remotely reachable: it remains bound to
`127.0.0.1` with exact Host and Origin checks. A separately reviewed private
HTTPS identity boundary is required before forwarding it to another machine.

## Local skeleton

```sh
pnpm console:host
```

The standalone command builds both apps and prints a launch URL. If Core is not
available, the workbench opens in a business-facing unavailable state without
showing the socket path or transport error.

Uploads use two calls: create a staging lease from browser-provided file
metadata, then upload bytes against that lease ID. No API accepts a caller
provided path. Only lease creation currently crosses the control protocol.
Content upload stays disabled until Core can issue a one-time loopback upload
capability; file bytes are never encoded into the 512 KiB JSON control frame.
