# The podGARDEN server

Runs the multiplayer game: podGAN tag for up to 8 players.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```
cd server
npm install
npm start
```

It prints `The podGARDEN server on http://localhost:8080`. Open that address in Chrome or Edge, type a name and press **Dive in**. Use `PORT=9000 npm start` (or `set PORT=9000` first on Windows) to pick another port.

## Let friends join

Everyone opens the server's address in their browser. The server sends them the game itself, so nobody needs to download anything.

- **Same Wi-Fi:** find your PC's local address (`ipconfig` on Windows, look for IPv4, e.g. `192.168.1.20`) and share `http://192.168.1.20:8080`. Allow Node through the Windows firewall when it asks.
- **Over the internet:** either forward port 8080 on your router to your PC and share `http://<your public IP>:8080`, or deploy this folder plus `../index.html` to a Node host such as Render, Railway or Fly.io. Those give you an `https://` address, and the game then connects over `wss://` automatically.

To point a game page at a server somewhere else, add `?server=host:port` to its address.

## Rules

- Everyone is a podGAN, one of the 1024 in the swarm. The mouse aims, **Space** jets (tap for one burst, hold for full jets), **right-click** squirts a 5 m ink cloud that hides everything, and **left-click** jumps you into the podGAN in the middle of your view.
- Once two players are in, one of you is **IT** (shown at the top of the screen and in red over their podGAN).
- Anyone can jump into wild podGANs to chase or escape. Only IT can jump into a podGAN another player is in. That's a tag: IT takes the body, and the tagged player is thrown into a random wild podGAN somewhere else and becomes IT. No tag-backs for 3 seconds.
- Score is total seconds spent as IT (hold Tab). Fewest wins.

## How it works

The server keeps track of who is in which podGAN, who is IT and the score, and enforces the jump and tag rules. Positions and ink are relayed between browsers. The lowest-numbered player "hosts" the podGANs: their browser sends everyone corrections twice a second, so all players see the swarm in the same place. If they leave, the next player takes over. `/status` lists who is playing.
