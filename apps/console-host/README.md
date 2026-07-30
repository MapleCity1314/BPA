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
