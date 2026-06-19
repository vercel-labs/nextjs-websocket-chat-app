import { experimental_upgradeWebSocket, type WebSocketData } from '@vercel/functions';
import { join, postMessage, postTyping, register, unregister } from '@/lib/chat';

// Wire-format the client sends over the socket.
type ClientEvent =
  | { type: 'join'; clientId: string; name: string }
  | { type: 'message'; text: string }
  | { type: 'typing' };

// A WebSocket connection starts as a GET request with an `Upgrade` header.
// `experimental_upgradeWebSocket` performs the upgrade and hands us the socket.
// See https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#experimental_upgradewebsocket
export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    // Register and attach listeners synchronously (no await before this), so a
    // `join` frame sent immediately on open is never dropped.
    register(ws);

    ws.on('message', (data: WebSocketData) => {
      let event: ClientEvent;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }

      switch (event.type) {
        case 'join':
          void join(ws, event.clientId, event.name);
          break;
        case 'message':
          void postMessage(ws, event.text);
          break;
        case 'typing':
          void postTyping(ws);
          break;
      }
    });

    const close = () => void unregister(ws);
    ws.on('close', close);
    // An error is always followed by a close, but clean up defensively.
    ws.on('error', close);
  });
}
