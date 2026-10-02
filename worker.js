//Первый запуск Cloudflare Worker
import { DurableObject } from "cloudflare:workers";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function makeCode() {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (value) => CODE_CHARS[value % CODE_CHARS.length]).join("");
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: cors });
		}

		if (url.pathname === "/api/create" && request.method === "POST") {
			const code = makeCode();
			return Response.json({ code }, { headers: cors });
		}

		if (url.pathname === "/ws") {
			const code = (url.searchParams.get("room") || "").toUpperCase();
			if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
				return new Response("Неверный код комнаты", { status: 400 });
			}
			const roomId = env.ROOMS.idFromName(code);
			return env.ROOMS.get(roomId).fetch(request);
		}

		return new Response("Танчики: сервер комнат работает", {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	},
};

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sessions = new Map();
	}

	async fetch(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Нужно WebSocket-соединение", { status: 426 });
		}

		const role = new URL(request.url).searchParams.get("role");
		if (role !== "host" && role !== "guest") {
			return new Response("Неверная роль игрока", { status: 400 });
		}
		if ([...this.sessions.values()].includes(role)) {
			return new Response("Это место в комнате уже занято", { status: 409 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.accept();
		this.sessions.set(server, role);
		server.addEventListener("message", (event) => this.onMessage(server, event.data));
		server.addEventListener("close", () => this.onClose(server));
		server.addEventListener("error", () => this.onClose(server));

		server.send(JSON.stringify({ type: "connected", role }));
		if (this.sessions.size === 2) this.broadcast({ type: "ready" });
		else server.send(JSON.stringify({ type: "waiting" }));

		return new Response(null, { status: 101, webSocket: client });
	}

	onMessage(socket, data) {
		if (typeof data !== "string" || data.length > 100_000) return;
		let message;
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		const role = this.sessions.get(socket);
		if (!role) return;

		for (const [other, otherRole] of this.sessions) {
			if (other === socket) continue;
			if (role === "guest" && otherRole === "host" && message.type === "input") {
				this.send(other, message);
			} else if (role === "host" && otherRole === "guest" && message.type === "state") {
				this.send(other, message);
			}
		}
	}

	onClose(socket) {
		const role = this.sessions.get(socket);
		if (!role) return;
		this.sessions.delete(socket);
		this.broadcast({ type: role === "host" ? "host_left" : "guest_left" });
	}

	send(socket, message) {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			this.onClose(socket);
		}
	}

	broadcast(message) {
		for (const socket of this.sessions.keys()) this.send(socket, message);
	}
}
