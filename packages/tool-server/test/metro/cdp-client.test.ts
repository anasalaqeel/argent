import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRestartAppTool } from "../../src/tools/restart-app";
import { expectNoForbiddenAdvice } from "../helpers/forbidden-advice";
import { pinsOnce } from "../helpers/pins";
import { platformTag } from "../helpers/platform-tag";
import { CDPClient } from "../../src/utils/debugger/cdp-client";

let wss: WebSocketServer;
let port: number;
let serverWs: WebSocket | null = null;

beforeEach(async () => {
  serverWs = null;
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      port = (wss.address() as { port: number }).port;
      resolve();
    });
  });
  wss.on("connection", (ws) => {
    serverWs = ws;
  });
});

afterEach(async () => {
  if (serverWs) serverWs.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function waitForServer(): Promise<WebSocket> {
  return new Promise((resolve) => {
    if (serverWs) return resolve(serverWs);
    wss.once("connection", (ws) => resolve(ws));
  });
}

describe("CDPClient", () => {
  /**
   * The premise the request-timeout message now rests on: a pause the session was
   * told about is refused before the timer is armed, so a timeout is evidence no
   * Debugger.paused arrived. Held behaviourally rather than as a comment, because
   * the message asserts what send() does and the two must not drift.
   */
  it("refuses Runtime.evaluate while paused instead of timing it out", async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id } = JSON.parse(String(raw)) as { id: number };
      ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: {
          reason: "other",
          callFrames: [{ url: "http://localhost:8081/index.bundle", location: { lineNumber: 41 } }],
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A timeout long enough that timing out rather than refusing would take it:
    // the rejection has to come from the guard, not from the timer.
    const err = await rejection(client.send("Runtime.evaluate", { expression: "1" }, 5_000));
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.JS_RUNTIME_PAUSED,
    });
    expect((err as Error).message).toContain(
      "paused at a breakpoint at http://localhost:8081/index.bundle:42"
    );
    await client.disconnect();
  });

  it("connects and disconnects", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("sends a command and receives response", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { debuggerId: "test-id" },
        })
      );
    });

    const result = await client.send("Runtime.enable");
    expect(result).toEqual({ debuggerId: "test-id" });
    expect(client.getEnabledDomains().has("Runtime")).toBe(true);
    await client.disconnect();
  });

  it("tracks enabled domains", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });

    await client.send("Debugger.enable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(true);

    await client.send("Debugger.disable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(false);

    await client.disconnect();
  });

  it("accumulates scriptParsed events", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "42",
            url: "http://localhost:8081/index.bundle",
            startLine: 0,
            endLine: 9999,
          },
        })
      );
    });

    await client.send("Debugger.enable");
    await new Promise((r) => setTimeout(r, 50));

    const scripts = client.getLoadedScripts();
    expect(scripts.has("42")).toBe(true);
    expect(scripts.get("42")!.url).toContain("index.bundle");

    await client.disconnect();
  });

  it("handles CDP errors", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        })
      );
    });

    await expect(client.send("Nonexistent.method")).rejects.toThrow("Method not found");
    await client.disconnect();
  });

  it("emits disconnected on server close", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const disconnected = new Promise<void>((resolve) => {
      client.events.on("disconnected", () => resolve());
    });

    const ws = await waitForServer();
    ws.close();

    await disconnected;
    expect(client.isConnected()).toBe(false);
  });

  it("evaluateWithBinding matches by requestId", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({
                  requestId: "req-123",
                  type: "inspect_result",
                  data: "test",
                }),
              },
            })
          );
        }, 10);
      }
    });

    const result = await client.evaluateWithBinding("someScript()", "req-123", { timeout: 5000 });

    expect(result.requestId).toBe("req-123");
    expect(result.type).toBe("inspect_result");
    expect(result.data).toBe("test");

    await client.disconnect();
  });

  it("evaluate requests returnByValue + awaitPromise and returns object results", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        // A returnByValue response carries the deep-serialized value. Without
        // returnByValue, Hermes/V8 return a RemoteObject ref with no `value`,
        // which is exactly the dropped-object bug this guards against.
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: "object", value: { a: 1, b: [2, 3] } } },
          })
        );
      }
    });

    const value = await client.evaluate("({ a: 1, b: [2, 3] })");

    expect(evalParams?.returnByValue).toBe(true);
    expect(evalParams?.awaitPromise).toBe(true);
    expect(value).toEqual({ a: 1, b: [2, 3] });

    await client.disconnect();
  });

  it("evaluateWithBinding drives the script with returnByValue + awaitPromise off", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({ requestId: "req-1", data: "x" }),
              },
            })
          );
        }, 10);
      }
    });

    await client.evaluateWithBinding("someScript()", "req-1", { timeout: 5000 });

    // The binding delivers the payload; the script's own return must not be
    // serialized or awaited, or fire-and-forget binding scripts would hang.
    expect(evalParams?.returnByValue).toBe(false);
    expect(evalParams?.awaitPromise).toBe(false);

    await client.disconnect();
  });

  // Failure-signal classification: each CDP transport fault must carry its own
  // precise code instead of surfacing as an unclassified plain Error (which
  // telemetry buckets under REGISTRY_SERVICE_INITIALIZATION_FAILED / unknown).
  describe("failure signal classification", () => {
    it("send before connect rejects with DEBUGGER_CDP_NOT_CONNECTED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      // never connect()ed
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP not connected");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
        failure_stage: "debugger_cdp_send",
        error_kind: "network",
      });
    });

    it("an unanswered request rejects with DEBUGGER_CDP_REQUEST_TIMEOUT", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      // The server never replies — the per-request timer must fire.
      const err = await rejection(client.send("Runtime.enable", {}, 50));
      expect((err as Error).message).toMatch(/CDP request Runtime\.enable \(id=\d+\) timed out/);
      // This client is shared with the Chromium path, and its own comment says the
      // message carries the recovery so skills need not re-explain it. It is also
      // the ONLY text a paused Chromium renderer reaches: the socket stays OPEN, so
      // debugger-status answers "connected" and the branching guidance is never
      // emitted. Both branches, through to their remedies - the message names the
      // paused state, and quitting there throws the user's session away.
      const message = (err as Error).message;
      // The third runtime string, held to the same bar as the two CHROMIUM_GUIDANCE
      // ones. It is the only text a paused Chromium renderer ever reaches, and it
      // was the one surface the shared list did not cover.
      expectNoForbiddenAdvice(message, "the CDP request-timeout message");
      // The diagnosis itself. Both remedies below are chosen off "reachable but not
      // answering"; a message that instead reports the runtime as gone sends the
      // reader straight past them to a relaunch.
      pinsOnce(
        message,
        "the runtime accepted the connection but did not answer; it may be frozen, or " +
          "paused at a breakpoint."
      );
      pinsOnce(
        message,
        "If it is paused, ask them to resume it — quitting throws the debug session away."
      );
      // The two arms are mutually destructive, so the message has to say what does
      // and does not narrow the choice. A pause the session was told about never
      // reaches this timer: send() rejects Runtime.evaluate up front through
      // BLOCKED_WHILE_PAUSED. That evidence is only as good as Debugger being
      // enabled, which the Chromium connect never does, so the ask stands. The
      // debugger-status half has to stay scoped to an established session: this same
      // message is the detail of a not_connected result when the connect pipeline is
      // what timed out.
      pinsOnce(
        message,
        "This send timed out rather than being refused, so no Debugger.paused reached this " +
          "session — with one in hand Runtime.evaluate is rejected up front as " +
          "JS_RUNTIME_PAUSED naming the location, never timed out."
      );
      pinsOnce(
        message,
        "That only rules out a pause the session was told about: Debugger is enabled on the " +
          "Metro connect and never on the Chromium one, and once the session is established " +
          'debugger-status reports "connected" either way — so have the user check the app ' +
          "before choosing."
      );
      // The claim this replaced, which the same send() disproves one branch above
      // the timer (see the JS_RUNTIME_PAUSED case below): pausedError names the
      // breakpoint and its location.
      expect(message, "does not deny that pausedness is ever reported").not.toMatch(
        /no tool reports pausedness/i
      );
      expect(message, "does not promise connected on the connect surface").not.toMatch(
        /debugger-status says "connected" either way/i
      );
      // The claim the two branches above rest on, and the ONLY copy of it: a
      // post-connect hang leaves the socket OPEN, so debugger-status reports
      // "connected" and never reaches the branching guidance. On the connect
      // surface this message IS the detail of a not_connected result, so an
      // unscoped second copy asserts a state the payload carrying it disproves.
      expect(message, "states the debugger-status claim once, scoped").not.toMatch(
        /debugger-status can still report "connected" in this state/
      );
      // Both ends of the retry discipline. Each attempt waits out this full timeout,
      // so a loosened "unless it looks slow" at one end or a "retry until it answers"
      // at the other undoes the reason the guidance is in the message at all.
      pinsOnce(message, "Do not retry in a loop. This send timed out rather than being refused");
      // Where the Chromium recovery lives. This message no longer restates it:
      // it named a relaunch procedure that had to stay in step with two guidance
      // strings and four prose surfaces, and the five drifted apart. The one
      // Chromium fact it must carry itself is that restart-app is refused - it is
      // the tool an agent reaches for from here - plus where the rest is.
      const restartApp = createRestartAppTool({} as unknown as Registry).capability;
      // Derived from restart-app's own capability, not restated: the same tag on the
      // skill rows is built this way, and a literal here drifts off it silently.
      pinsOnce(
        message,
        `If it is hung, get the app restarted: restart-app on ${platformTag(restartApp)}.`
      );
      pinsOnce(
        message,
        "On Chromium restart-app is refused and boot-device only starts an app, so the quit " +
          "is the user's and the relaunch has to wait for the exit — call debugger-status " +
          "for the recovery."
      );
      pinsOnce(message, "Then reconnect and retry once.");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
        failure_stage: "debugger_cdp_send",
        error_kind: "timeout",
      });
      await client.disconnect();
    });

    it("server close mid-request rejects the pending send with DEBUGGER_CDP_CONNECTION_CLOSED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      const ws = await waitForServer();
      ws.on("message", () => ws.close());
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP connection closed");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
        failure_stage: "debugger_cdp_lifecycle",
        error_kind: "network",
      });
    });

    it("connect to a dead port rejects with a classified connect-stage code", async () => {
      // Grab a port nothing listens on: bind an ephemeral server, then close it.
      const deadPort = await new Promise<number>((resolve) => {
        const probe = new WebSocketServer({ port: 0 }, () => {
          const p = (probe.address() as { port: number }).port;
          probe.close(() => resolve(p));
        });
      });
      const client = new CDPClient(`ws://localhost:${deadPort}`);
      const err = await rejection(client.connect());
      const signal = getFailureSignal(err);
      // ECONNREFUSED surfaces via the error handler (CONNECT_FAILED); some
      // stacks deliver only a close (SOCKET_CLOSED_BEFORE_OPEN). Either way the
      // stage must be the connect stage and the kind network.
      expect([
        FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
        FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN,
      ]).toContain(signal?.error_code);
      expect(signal).toMatchObject({
        failure_stage: "debugger_cdp_connect",
        error_kind: "network",
      });
    });
  });
});
