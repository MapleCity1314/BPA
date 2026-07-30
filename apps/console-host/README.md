# BPA Console Host

The Console Host is a short-lived, loopback-only HTTP boundary for the BPA
Operator Console. It does not import Local Core, access SQLite, or accept local
filesystem paths.

## Integration

Inject an implementation of `ControlBackend` from
`@bpa/operator-console-contracts` and call `startConsoleHost`. The future UDS
adapter remains outside this package.

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

The standalone command builds both apps and prints a launch URL. It deliberately
uses `UnavailableControlBackend`; it is useful for security and static-resource
validation, not for real workflow execution.

Uploads use two calls: create a staging lease from browser-provided file
metadata, then upload bytes against that lease ID. No API accepts a caller
provided path.
