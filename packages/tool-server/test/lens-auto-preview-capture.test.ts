/**
 * `propose_variant` captures the variant preview itself: it screenshots the
 * round's device and hashes the capture, so the agent needs no separate
 * `screenshot` call and no by-hand `shasum`. Both inputs are server-side — the
 * tool holds the round's device and describes it at propose time for the crop
 * frame — so these pin the capture, the device fallback, the missing-device
 * refusal, the screenshot-failure surface and the duplicate guard.
 *
 * The store is a module singleton whose `device` deliberately outlives `reset()`,
 * so every test takes a fresh module graph (`vi.resetModules()` + dynamic import)
 * rather than sharing one round's device.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Registry } from "@argent/registry";

// captureElementFrame shells `xcrun`/`adb` at propose time. Stubbed, but the
// stub records the device it was handed and can be made to park: the real one
// awaits a describe (up to CAPTURE_BUDGET_MS), and that await is the window two
// overlapping proposes would race through.
const frameStub = vi.hoisted(() => ({
  udids: [] as string[],
  delayMs: 0,
  frame: null as null | { x: number; y: number; width: number; height: number },
}));
vi.mock("../src/utils/match-element-frame", () => ({
  captureElementFrame: vi.fn(async (_registry: unknown, udid: string) => {
    frameStub.udids.push(udid);
    if (frameStub.delayMs) await new Promise((r) => setTimeout(r, frameStub.delayMs));
    return frameStub.frame;
  }),
}));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-lens-preview-test-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** A capture file on disk; equal `bytes` across two files means equal content. */
function shotFile(name: string, bytes: string): string {
  const file = path.join(tmpDir, `${name}.png`);
  fs.writeFileSync(file, bytes);
  return file;
}

type ProposeStore = typeof import("../src/utils/variant-proposals").variantProposalStore;

/**
 * A registry holding the real `propose_variant` plus a stub `screenshot` that
 * hands back `shots` in order (repeating the last one once exhausted), so a test
 * decides exactly what bytes the tool sees.
 */
async function freshLens(shots: string[]): Promise<{
  registry: Registry;
  store: ProposeStore;
  shotCalls: Array<Record<string, unknown>>;
}> {
  vi.resetModules();
  const { variantProposalStore } = await import("../src/utils/variant-proposals");
  const { createProposeVariantTool } = await import("../src/tools/variants/propose-variant");

  const registry = new Registry();
  const shotCalls: Array<Record<string, unknown>> = [];
  registry.registerTool<{ udid: string; includeImageInContext?: boolean }>({
    id: "screenshot",
    zodSchema: z.object({ udid: z.string(), includeImageInContext: z.boolean().optional() }),
    services: () => ({}),
    async execute(_services, params) {
      shotCalls.push({ ...params });
      const hostPath = shots[shotCalls.length - 1] ?? shots[shots.length - 1]!;
      return { image: { hostPath } };
    },
  });
  registry.registerTool(createProposeVariantTool(registry));
  return { registry, store: variantProposalStore, shotCalls };
}

/**
 * Like `freshLens`, but the stub `screenshot` throws — so a test can pin what
 * `propose_variant` does when the capture cannot be taken.
 */
async function freshLensFailingScreenshot(error: Error): Promise<{
  registry: Registry;
  store: ProposeStore;
  shotCalls: Array<Record<string, unknown>>;
}> {
  vi.resetModules();
  const { variantProposalStore } = await import("../src/utils/variant-proposals");
  const { createProposeVariantTool } = await import("../src/tools/variants/propose-variant");

  const registry = new Registry();
  const shotCalls: Array<Record<string, unknown>> = [];
  registry.registerTool<{ udid: string; includeImageInContext?: boolean }>({
    id: "screenshot",
    zodSchema: z.object({ udid: z.string(), includeImageInContext: z.boolean().optional() }),
    services: () => ({}),
    async execute(_services, params) {
      shotCalls.push({ ...params });
      throw error;
    },
  });
  registry.registerTool(createProposeVariantTool(registry));
  return { registry, store: variantProposalStore, shotCalls };
}

const variant = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  summary: `${name} summary`,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  frameStub.udids = [];
  frameStub.delayMs = 0;
  frameStub.frame = null;
});

describe("propose_variant — server-side preview capture", () => {
  it("screenshots the device when variant.previewImage is omitted", async () => {
    const shot = shotFile("solo", "outlined-pixels");
    const { registry, store, shotCalls } = await freshLens([shot]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });

    expect(shotCalls).toEqual([{ udid: "SIM-1", includeImageInContext: false }]);
    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants[0]!.previewImage).toBe(shot);
  });

  it("uses an explicitly passed previewImage verbatim and takes no screenshot", async () => {
    const { registry, store, shotCalls } = await freshLens([shotFile("unused", "unused")]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined", { previewImage: "/var/folders/x/agent-shot.png" }),
    });

    expect(shotCalls).toEqual([]);
    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants[0]!.previewImage).toBe("/var/folders/x/agent-shot.png");
  });

  it("treats a blank previewImage as absent and captures instead of staging it", async () => {
    const shot = shotFile("blank-override", "captured-pixels");
    const { registry, store, shotCalls } = await freshLens([shot]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined", { previewImage: "   " }),
    });

    expect(shotCalls).toHaveLength(1);
    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants[0]!.previewImage).toBe(shot);
  });

  it("captures from the round's device when a later propose omits udid", async () => {
    const first = shotFile("first", "variant-one");
    const second = shotFile("second", "variant-two");
    const { registry, shotCalls } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    await registry.invokeTool("propose_variant", {
      element: "Search field",
      variant: variant("Pill"),
    });

    expect(shotCalls.map((c) => c.udid)).toEqual(["SIM-1", "SIM-1"]);
    // The crop frame resolves the device the same way, so the second propose
    // describes the round's device instead of silently getting no frame.
    expect(frameStub.udids).toEqual(["SIM-1", "SIM-1"]);
  });

  it("prefers an explicitly passed udid over the stored device", async () => {
    const { registry, shotCalls } = await freshLens([
      shotFile("dev-a", "screen-a"),
      shotFile("dev-b", "screen-b"),
    ]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-2",
      variant: variant("Pill"),
    });

    expect(shotCalls.map((c) => c.udid)).toEqual(["SIM-1", "SIM-2"]);
    expect(frameStub.udids).toEqual(["SIM-1", "SIM-2"]);
  });

  it("puts the auto-captured frame on the staged variant", async () => {
    frameStub.frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const { registry, store } = await freshLens([shotFile("framed", "framed-pixels")]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });

    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants[0]!.frame).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it("refuses, staging nothing, when no device is known and no previewImage is given", async () => {
    const { registry, store, shotCalls } = await freshLens([shotFile("never", "never")]);

    await expect(
      registry.invokeTool("propose_variant", {
        element: "Search field",
        variant: variant("Outlined"),
      })
    ).rejects.toThrow(/no device to capture the variant preview/i);

    expect(shotCalls).toEqual([]);
    expect(store.snapshot().proposals).toEqual([]);
  });

  it("propagates a screenshot failure and stages nothing", async () => {
    const { registry, store, shotCalls } = await freshLensFailingScreenshot(
      new Error("Screenshot failed: simulator-server not reachable")
    );

    await expect(
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        variant: variant("Outlined"),
      })
    ).rejects.toThrow(/Screenshot failed/i);

    // The capture was attempted, and its failure blocked staging.
    expect(shotCalls).toEqual([{ udid: "SIM-1", includeImageInContext: false }]);
    expect(store.snapshot().proposals).toEqual([]);
  });
});

describe("propose_variant — duplicate-capture guard", () => {
  it("refuses a capture identical to another variant of the same element, naming it", async () => {
    // Two distinct paths, identical bytes: the guard must hash content, not
    // compare paths — a fresh screenshot path is exactly what a frozen device
    // hands back.
    const first = shotFile("dup-a", "identical-screen");
    const second = shotFile("dup-b", "identical-screen");
    const { registry, store } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    await expect(
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        variant: variant("Pill"),
      })
    ).rejects.toThrow(/byte-identical .*variant "Outlined"/i);

    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants.map((v) => v.name)).toEqual(["Outlined"]);
  });

  it("allows two elements of one screen to share the same capture", async () => {
    const first = shotFile("shared-a", "one-screen-two-elements");
    const second = shotFile("shared-b", "one-screen-two-elements");
    const { registry, store } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    await registry.invokeTool("propose_variant", {
      element: "Primary CTA",
      udid: "SIM-1",
      variant: variant("Gradient"),
    });

    expect(store.snapshot().proposals.map((p) => p.element)).toEqual([
      "Search field",
      "Primary CTA",
    ]);
  });

  it("compares only within the live round, not one the human already submitted", async () => {
    const first = shotFile("round-a", "same-bytes-next-round");
    const second = shotFile("round-b", "same-bytes-next-round");
    const { registry, store } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    const staged = store.snapshot().proposals[0]!;
    store.submitSelection({ selections: [{ elementId: staged.id, variantId: null }] });

    // Round 1 is finished, so its capture is not a twin of round 2's first one.
    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined again"),
    });

    const snap = store.snapshot();
    expect(snap.round).toBe(2);
    expect(snap.proposals[0]!.variants.map((v) => v.name)).toEqual(["Outlined again"]);
  });

  it("does not hash an explicitly passed previewImage into the guard", async () => {
    const shot = shotFile("explicit-twin", "identical-screen-explicit");
    const { registry, store } = await freshLens([shot]);

    // The agent supplies the same image the server would have captured; an
    // explicit path is honored as-is, so this stages rather than refusing.
    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined", { previewImage: shot }),
    });
    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Pill", { previewImage: shot }),
    });

    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants.map((v) => v.name)).toEqual(["Outlined", "Pill"]);
  });

  it("refuses both-staging when two proposes of one element overlap across the describe", async () => {
    // The compare and the append are one synchronous step inside the store. If
    // the tool compared before `captureElementFrame`, both of these would pass
    // that check during the park and both would stage the same thumbnail.
    const first = shotFile("race-a", "identical-screen");
    const second = shotFile("race-b", "identical-screen");
    const { registry, store } = await freshLens([first, second]);
    frameStub.delayMs = 50;

    const results = await Promise.allSettled([
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        variant: variant("Outlined"),
      }),
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        variant: variant("Pill"),
      }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants).toHaveLength(1);
  });

  it("tells an agent re-proposing the same variant that it is already staged", async () => {
    const first = shotFile("same-a", "identical-screen");
    const second = shotFile("same-b", "identical-screen");
    const { registry, store } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      variant: variant("Outlined"),
    });
    // Re-proposing the SAME variant is not evidence that it is off screen — it
    // is on screen, and staged. Saying "not on screen, re-apply it" would send
    // the agent round a loop whose remedy cannot change the capture.
    await expect(
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        variant: variant("Outlined"),
      })
    ).rejects.toThrow(/"Outlined" of "Search field" is already staged/i);

    const [proposal] = store.snapshot().proposals;
    expect(proposal!.variants.map((v) => v.name)).toEqual(["Outlined"]);
  });

  it("names the card the twin is actually on, not the element of the refused call", async () => {
    // One matcher is one card, so these two names collapse onto "Save button".
    // Reporting the refused call's own `element` would name a card that does not
    // hold the twin — and does not exist.
    const first = shotFile("attrib-a", "identical-screen");
    const second = shotFile("attrib-b", "identical-screen");
    const { registry } = await freshLens([first, second]);
    const match = { by: "role" as const, value: "Button" };

    await registry.invokeTool("propose_variant", {
      element: "Save button",
      udid: "SIM-1",
      match,
      variant: variant("Solid"),
    });
    await expect(
      registry.invokeTool("propose_variant", {
        element: "Cancel button",
        udid: "SIM-1",
        match,
        variant: variant("Ghost"),
      })
    ).rejects.toThrow(/variant "Solid" of "Save button"/);
  });

  it("dup-checks one element across case- and whitespace-divergent matchers", async () => {
    // proposalKey normalizes the matcher, so "Search" and "  search  " are the
    // same card — and the duplicate guard, which reuses that key, runs across it.
    const first = shotFile("norm-a", "identical-screen");
    const second = shotFile("norm-b", "identical-screen");
    const { registry, store } = await freshLens([first, second]);

    await registry.invokeTool("propose_variant", {
      element: "Search field",
      udid: "SIM-1",
      match: { by: "text", value: "Search" },
      variant: variant("Outlined"),
    });
    await expect(
      registry.invokeTool("propose_variant", {
        element: "Search field",
        udid: "SIM-1",
        match: { by: "text", value: "  search  " },
        variant: variant("Pill"),
      })
    ).rejects.toThrow(/byte-identical .*variant "Outlined"/i);

    expect(store.snapshot().proposals).toHaveLength(1);
    expect(store.snapshot().proposals[0]!.variants.map((v) => v.name)).toEqual(["Outlined"]);
  });
});
