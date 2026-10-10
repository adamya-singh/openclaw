import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { snapshotRoleViaCdp } from "./cdp.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import {
  closePlaywrightBrowserConnection,
  getMainFrameDocumentIdentityViaPlaywright,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { BROWSER_REF_MARKER_ATTRIBUTE } from "./pw-session.page-cdp.js";
import { clickViaPlaywright, typeViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import {
  snapshotAiViaPlaywright,
  snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright,
  storeSnapshotRefsViaPlaywright,
} from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Chromium snapshot-to-action name fidelity",
  () => {
    it("reconnects to preloaded OOPIF descendants with usable execution and utility worlds", async () => {
      const rootDir = tempDirs.make("openclaw-preloaded-frame-tree-");
      const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        if (request.url === "/launch") {
          response.end('<h1>Launch</h1><iframe src="/reading"></iframe>');
        } else if (request.url === "/reading") {
          response.end('<p>Reading passage</p><iframe src="/sidebar"></iframe>');
        } else if (request.url === "/sidebar") {
          response.end(
            "<textarea aria-label=\"Response\"></textarea><button onclick=\"document.querySelector('output').textContent=document.querySelector('textarea').value\">Preview</button><output></output>",
          );
        } else if (request.url === "/local") {
          response.end('<iframe srcdoc="<button>Local control</button>"></iframe>');
        } else {
          const port = (server.address() as AddressInfo).port;
          response.end(`<h1>Main</h1><iframe src="http://localhost:${port}/launch"></iframe>`);
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const cdpPort = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      let context: import("playwright-core").BrowserContext | undefined;
      try {
        context = await getPlaywrightCore().chromium.launchPersistentContext(
          path.join(rootDir, "profile"),
          {
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: [`--remote-debugging-port=${cdpPort}`, "--site-per-process", "--no-proxy-server"],
          },
        );
        const page = context.pages()[0] ?? (await context.newPage());
        const rootUrl = `http://127.0.0.1:${port}/`;
        const sidebarUrl = `http://localhost:${port}/sidebar`;
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const target = { cdpUrl, targetId: targetInfo.targetId };

        // Exercise initial empty-page attachment as well as an already-loaded tree.
        expect((await getPageForTargetId(target)).url()).toBe("about:blank");
        await closePlaywrightBrowserConnection({ cdpUrl });
        await page.goto(rootUrl);
        await page
          .frameLocator("iframe")
          .frameLocator("iframe")
          .frameLocator("iframe")
          .getByRole("textbox", { name: "Response" })
          .waitFor();

        for (let connection = 0; connection < 2; connection++) {
          const attached = await getPageForTargetId(target);
          expect(attached.frames()).toHaveLength(4);
          expect(new Set(attached.frames()).size).toBe(4);
          for (const frame of attached.frames()) {
            await frame.waitForLoadState("domcontentloaded", { timeout: 2_000 });
            await frame.waitForLoadState("load", { timeout: 2_000 });
            expect(await frame.evaluate(() => location.href)).toBe(frame.url());
          }
          const reading = attached.frames().find((frame) => frame.url().endsWith("/reading"))!;
          const sidebar = attached.frames().find((frame) => frame.url() === sidebarUrl)!;
          expect(sidebar.parentFrame()).toBe(reading);
          expect(reading.parentFrame()?.url()).toBe(`http://localhost:${port}/launch`);
          expect(await reading.getByText("Reading passage").textContent()).toBe("Reading passage");
          await sidebar.getByRole("textbox", { name: "Response" }).fill(`response ${connection}`);
          await sidebar.getByRole("button", { name: "Preview" }).click();
          expect(await sidebar.locator("output").textContent()).toBe(`response ${connection}`);

          await attached.goto(`${rootUrl}local`);
          await attached
            .frameLocator("iframe")
            .getByRole("button", { name: "Local control" })
            .waitFor();
          expect(sidebar.isDetached()).toBe(true);
          expect(attached.frames()).toHaveLength(2);
          await attached
            .frameLocator("iframe")
            .getByRole("button", { name: "Local control" })
            .click();
          await attached.goto(rootUrl);
          await attached
            .frameLocator("iframe")
            .frameLocator("iframe")
            .frameLocator("iframe")
            .getByRole("textbox", { name: "Response" })
            .waitFor();
          await attached.reload();
          await attached
            .frameLocator("iframe")
            .frameLocator("iframe")
            .frameLocator("iframe")
            .getByRole("textbox", { name: "Response" })
            .waitFor();
          await closePlaywrightBrowserConnection({ cdpUrl });
        }
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }, 30_000);

    it("returns selector no-match snapshots without waiting for the snapshot timeout", async () => {
      const rootDir = tempDirs.make("openclaw-snapshot-selector-absence-");
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setContent(
          '<main><button id="present">Present</button><a href="https://example.test/docs">Docs</a></main>',
        );
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const target = { cdpUrl, targetId: targetInfo.targetId };

        const startedAt = performance.now();
        const missing = await snapshotRoleViaPlaywright({
          ...target,
          selector: "#missing",
          timeoutMs: 30_000,
          urls: true,
        });
        const elapsedMs = performance.now() - startedAt;
        const present = await snapshotRoleViaPlaywright({
          ...target,
          selector: "#present",
          timeoutMs: 30_000,
        });

        const refFree = await snapshotRoleViaPlaywright({
          ...target,
          selector: "main",
          options: { maxDepth: 0 },
          timeoutMs: 30_000,
          urls: true,
        });

        expect(missing.snapshot).toBe("(empty)");
        expect(missing.snapshot).not.toContain("https://example.test/docs");
        expect(missing.refs).toEqual({});
        expect(elapsedMs).toBeLessThan(1_000);
        expect(present.snapshot).toContain('button "Present"');
        expect(refFree.refs).toEqual({});
        expect(refFree.snapshot).toContain("https://example.test/docs");
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);

    it("publishes actionable main-frame CDP refs into the Playwright cache", async () => {
      const rootDir = tempDirs.make("openclaw-cdp-role-refs-");
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setContent(
          [
            "<button onclick=\"document.querySelector('output').textContent='first'\">Native</button>",
            "<button onclick=\"document.querySelector('output').textContent='second'\">Native</button>",
            "<div style=\"cursor:pointer\" onclick=\"document.querySelector('output').textContent='cursor'\">Cursor card</div>",
            "<output></output>",
            '<iframe srcdoc="<button>Child frame</button>"></iframe>',
          ].join(""),
        );
        await page.frameLocator("iframe").getByRole("button").waitFor();
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const targets = (await fetch(`${cdpUrl}/json/list`).then((res) => res.json())) as Array<{
          id?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const wsUrl = targets.find(
          (target) => target.id === targetInfo.targetId,
        )?.webSocketDebuggerUrl;
        expect(wsUrl).toBeTypeOf("string");
        const target = { cdpUrl, targetId: targetInfo.targetId };
        const snapshot = await snapshotRoleViaCdp({
          wsUrl: wsUrl!,
          options: { interactive: true },
          recurseIframes: false,
        });
        const nativeRefs = Object.entries(snapshot.refs).filter(
          ([, info]) => info.name === "Native",
        );
        const cursorRef = Object.entries(snapshot.refs).find(
          ([, info]) => info.name === "Cursor card",
        )?.[0];

        expect(nativeRefs).toHaveLength(2);
        expect(cursorRef).toBeDefined();
        expect(Object.values(snapshot.refs).some((info) => info.name === "Child frame")).toBe(
          false,
        );
        const expectedDocumentIdentity = await getMainFrameDocumentIdentityViaPlaywright(target);
        const nativeRefSet = new Set(nativeRefs.map(([ref]) => ref));
        const newCdpSession = context.newCDPSession.bind(context);
        const newCdpSessionSpy = vi
          .spyOn(context, "newCDPSession")
          .mockImplementation(async (pageOrFrame) => {
            const markerSession = await newCdpSession(pageOrFrame);
            const send = markerSession.send.bind(markerSession);
            vi.spyOn(markerSession, "send").mockImplementation((async (
              method: string,
              params?: Record<string, unknown>,
            ) => {
              const markerValue = typeof params?.value === "string" ? params.value : "";
              if (method === "DOM.setAttributeValue" && nativeRefSet.has(markerValue)) {
                throw new Error("marker write blocked");
              }
              return await (
                send as (method: string, params?: Record<string, unknown>) => Promise<unknown>
              )(method, params);
            }) as typeof markerSession.send);
            return markerSession;
          });
        try {
          await storeSnapshotRefsViaPlaywright({
            ...target,
            page,
            refs: snapshot.refs,
            expectedDocumentIdentity,
          });
        } finally {
          newCdpSessionSpy.mockRestore();
        }

        for (const [ref] of nativeRefs) {
          expect(await page.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${ref}"]`).count()).toBe(0);
        }
        for (const [index, [ref]] of nativeRefs.entries()) {
          await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
          expect(await page.locator("output").textContent()).toBe(["first", "second"][index]);
        }
        expect(nativeRefs.map(([, info]) => info.nth)).toEqual([0, 1]);
        await clickViaPlaywright({ ...target, ref: cursorRef!, timeoutMs: 1_000 });
        expect(await page.locator("output").textContent()).toBe("cursor");
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);

    it("resolves encoded and omitted names, raw AX names, and native frame refs", async () => {
      const rootDir = tempDirs.make("openclaw-snapshot-labels-");
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(rootDir, "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.setContent(
          '<style>button{min-width:30px;min-height:25px}</style><main></main><output></output><iframe title="Nested"></iframe>',
        );
        const buttonName = 'Save: "owner\'s" C:\\draft 🦞';
        const inputName = 'Project "path"';
        const nameControls = [
          { id: "short", name: "Named control" },
          { id: "empty", name: "" },
          { id: "empty-again", name: "" },
          { id: "name-900", name: "x".repeat(900) },
          { id: "name-901", name: "x".repeat(901) },
          { id: "surrogates-900", name: "😀".repeat(450) },
          { id: "surrogates-901", name: "😀".repeat(450) + "x" },
          { id: "normalized-empty", name: "\u200b\u00ad" },
          { id: "normalized-899", name: "  x \n".repeat(450) },
          { id: "normalized-901", name: "  x \n".repeat(451) },
        ];
        await page.evaluate(
          ({ buttonName: label, inputName: inputLabel, nameControls: controls }) => {
            for (const id of ["first", "second"]) {
              const button = document.createElement("button");
              button.textContent = label;
              button.addEventListener("click", () => {
                document.querySelector("output")!.textContent = id;
              });
              document.querySelector("main")!.append(button);
            }
            const input = document.createElement("input");
            input.setAttribute("aria-label", inputLabel);
            document.querySelector("main")!.append(input);
            const slash = document.createElement("button");
            slash.textContent = "/";
            slash.addEventListener("click", () => {
              document.querySelector("output")!.textContent = "/";
            });
            document.querySelector("main")!.append(slash);
            for (const { id, name } of controls) {
              const button = document.createElement("button");
              button.setAttribute("aria-label", name);
              button.textContent = name ? "control" : "";
              button.addEventListener("click", () => {
                document.querySelector("output")!.textContent = id;
              });
              document.querySelector("main")!.append(button);
            }
            document.querySelector("iframe")!.srcdoc =
              "<button onclick=\"this.textContent='Frame clicked'\">Frame: action</button>";
          },
          { buttonName, inputName, nameControls },
        );
        await page.frameLocator("iframe").getByRole("button").waitFor();
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const target = { cdpUrl, targetId: targetInfo.targetId };
        for (const mode of ["role", "interactive", "ai", "interactive-aria"] as const) {
          const snapshot =
            mode === "ai"
              ? await snapshotAiViaPlaywright(target)
              : await snapshotRoleViaPlaywright({
                  ...target,
                  refsMode: mode === "interactive-aria" ? "aria" : "role",
                  options: { interactive: mode !== "role" },
                });
          const buttons = Object.entries(snapshot.refs).filter(
            ([, value]) => value.role === "button" && value.name !== "Frame: action",
          );
          const expectedButtons = ["first", "second", "/", ...nameControls.map(({ id }) => id)];
          expect(buttons, mode).toHaveLength(expectedButtons.length);
          for (const [index, [ref]] of buttons.entries()) {
            await clickViaPlaywright({ ...target, ref, timeoutMs: 1_000 });
            expect(await page.locator("output").textContent(), mode).toBe(expectedButtons[index]);
          }
          const input = Object.entries(snapshot.refs).find(
            ([, value]) => value.role === "textbox" && value.name === inputName,
          );
          expect(input, mode).toBeDefined();
          await typeViaPlaywright({ ...target, ref: input![0], text: mode, timeoutMs: 1_000 });
          expect(await page.getByRole("textbox").inputValue()).toBe(mode);
        }
        const snapshot = await snapshotAiViaPlaywright(target);
        const nested = Object.entries(snapshot.refs).find(
          ([, value]) => value.name === "Frame: action",
        );
        expect(nested).toBeDefined();
        await clickViaPlaywright({ ...target, ref: nested![0], timeoutMs: 1_000 });
        expect(await page.frameLocator("iframe").getByRole("button").textContent()).toBe(
          "Frame clicked",
        );

        await page.setContent(
          "<style>button{min-width:30px;min-height:25px}</style><main></main><output></output>",
        );
        const rawControls = [
          { id: "raw-short", name: "Raw named control" },
          { id: "raw-empty", name: "" },
          { id: "raw-long", name: "x".repeat(901) },
          { id: "raw-short-again", name: "Raw named control" },
        ];
        await page.evaluate((controls) => {
          for (const { id, name } of controls) {
            const button = document.createElement("button");
            button.setAttribute("aria-label", name);
            button.textContent = name ? "control" : "";
            button.addEventListener("click", () => {
              document.querySelector("output")!.textContent = id;
            });
            document.querySelector("main")!.append(button);
          }
        }, rawControls);
        const aria = await snapshotAriaViaPlaywright(target);
        const rawButtons = aria.nodes.filter((node) => node.role.toLowerCase() === "button");
        expect(rawButtons).toHaveLength(rawControls.length);
        expect(
          await page
            .getByRole("button", { name: "", exact: true })
            .getAttribute(BROWSER_REF_MARKER_ATTRIBUTE),
        ).toBe(rawButtons[1]!.ref);
        await clickViaPlaywright({ ...target, ref: rawButtons[1]!.ref, timeoutMs: 1_000 });
        expect(await page.locator("output").textContent()).toBe("raw-empty");
        // Real AX names with unavailable DOM ids exercise the existing role fallback.
        // Restore onto the launcher's distinct Page wrapper to cross the target cache.
        await storeSnapshotRefsViaPlaywright({
          ...target,
          nodes: aria.nodes.map(({ backendDOMNodeId: _backendId, ...node }) => node),
        });
        expect(await page.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`).count()).toBe(0);
        restoreRoleRefsForTarget({ ...target, page });
        for (const [index, node] of rawButtons.entries()) {
          await refLocator(page, node.ref).click({ timeout: 1_000 });
          expect(await page.locator("output").textContent()).toBe(rawControls[index]!.id);
        }
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);
  },
);
