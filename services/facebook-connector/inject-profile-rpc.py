#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: inject-profile-rpc.py /path/to/bridge-e2ee/main.go")

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")

if 'case "getUserInfo":' in source:
    print("getUserInfo RPC already present")
    raise SystemExit(0)

# Add imports required by the profile RPC.
source = source.replace(
    'import (\n\t"bufio"',
    'import (\n\t"bufio"\n\t"context"',
    1,
)
source = source.replace(
    '\t"sync"\n\n\t"fbchat-bridge-e2ee/bridge"',
    '\t"sync"\n\t"time"\n\n\t"fbchat-bridge-e2ee/bridge"\n\t"go.mau.fi/mautrix-meta/pkg/messagix/socket"',
    1,
)

anchor = '\tcase "connectE2EE":\n'
if anchor not in source:
    raise SystemExit("unable to find connectE2EE switch anchor in upstream main.go")

profile_case = r'''\tcase "getUserInfo":
\t\tif client == nil {
\t\t\tfail(req.ID, fmt.Errorf("client not initialised"))
\t\t\treturn
\t\t}
\t\tvar p struct {
\t\t\tUserID int64 `json:"userId"`
\t\t}
\t\tif err := json.Unmarshal(req.Params, &p); err != nil {
\t\t\tfail(req.ID, err)
\t\t\treturn
\t\t}
\t\tif p.UserID <= 0 {
\t\t\tfail(req.ID, fmt.Errorf("invalid userId"))
\t\t\treturn
\t\t}

\t\tctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
\t\tdefer cancel()

\t\t// ExecuteTasks needs the Messenger LightSpeed socket to be ready. Connect()
\t\t// starts that socket asynchronously, so wait explicitly before querying.
\t\tif err := client.Messagix.WaitUntilCanSendMessages(ctx, 15*time.Second); err != nil {
\t\t\tfail(req.ID, fmt.Errorf("waiting for Messenger socket: %w", err))
\t\t\treturn
\t\t}

\t\ttbl, err := client.Messagix.ExecuteTasks(ctx, &socket.GetContactsFullTask{ContactID: p.UserID})
\t\tif err != nil {
\t\t\tfail(req.ID, fmt.Errorf("get contact profile: %w", err))
\t\t\treturn
\t\t}
\t\tif tbl == nil || len(tbl.LSDeleteThenInsertContact) == 0 {
\t\t\tfail(req.ID, fmt.Errorf("user info not found for %d", p.UserID))
\t\t\treturn
\t\t}

\t\tinfo := tbl.LSDeleteThenInsertContact[0]
\t\tok(req.ID, map[string]interface{}{
\t\t\t"id":                info.GetFBID(),
\t\t\t"name":              info.GetName(),
\t\t\t"username":          info.GetUsername(),
\t\t\t"profilePictureUrl": info.GetAvatarURL(),
\t\t})

'''.replace('\\t', '\t')

source = source.replace(anchor, profile_case + anchor, 1)

# Guard against partial injection: all imports must exist.
required = [
    '"context"',
    '"time"',
    '"go.mau.fi/mautrix-meta/pkg/messagix/socket"',
    'case "getUserInfo":',
]
missing = [item for item in required if item not in source]
if missing:
    raise SystemExit(f"injection incomplete, missing: {missing}")

path.write_text(source, encoding="utf-8")
print(f"injected getUserInfo RPC into {path}")
