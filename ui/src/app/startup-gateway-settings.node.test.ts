// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  selectGatewaySettings,
  type UiSettings,
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function setControlUiBasePath(value: string | undefined) {
  if (value == null) {
    Reflect.deleteProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__");
    return;
  }
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value,
    writable: true,
    configurable: true,
  });
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function makeSettings(gatewayUrl: string, overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveApplicationStartupSettings", () => {
  it("strips fragment bootstrap tokens without persisting them", () => {
    const startup = resolveApplicationStartupSettings(makeSettings("wss://gateway.example"), {
      pathname: "/",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway.example&bootstrapToken=boot-123",
    });

    expect(startup.pendingGatewayUrl).toBeNull();
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-123");
    expect(startup.settings.token).toBe("");
    expect(startup.location).toEqual({ pathname: "/", search: "", hash: "" });
  });

  it("carries fragment bootstrap tokens with changed gateway URLs", () => {
    const startup = resolveApplicationStartupSettings(makeSettings("wss://gateway-a.example"), {
      pathname: "/dash",
      search: "",
      hash: "#gatewayUrl=wss%3A%2F%2Fgateway-b.example&bootstrapToken=boot-456",
    });

    expect(startup.pendingGatewayUrl).toBe("wss://gateway-b.example");
    expect(startup.pendingGatewayToken).toBeNull();
    expect(startup.pendingBootstrapToken).toBe("boot-456");
    expect(startup.location).toEqual({ pathname: "/dash", search: "", hash: "" });
  });

  it("adopts native-auth Gateway settings without grafting the previous scope", () => {
    setTestLocation({ protocol: "https:", host: "native.example", pathname: "/openclaw" });
    const gatewayA = "wss://native.example/openclaw?tenant=a";
    const gatewayB = "wss://native.example/openclaw?tenant=b";
    selectGatewaySettings(gatewayB, {
      theme: "dash",
      navCollapsed: true,
      sidebarEntries: ["route:usage"],
    });
    const initial = selectGatewaySettings(gatewayA, {
      theme: "knot",
      navCollapsed: false,
      sidebarEntries: ["route:chat"],
    });
    Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
      value: { gatewayUrl: gatewayB, token: "native-token" },
      configurable: true,
    });

    const startup = resolveApplicationStartupSettings(initial, {
      pathname: "/",
      search: "",
      hash: "",
    });

    expect(startup.settings).toMatchObject({
      gatewayUrl: gatewayB,
      token: "native-token",
      theme: "dash",
      navCollapsed: true,
      sidebarEntries: ["route:usage"],
    });
    expect(loadSettings(gatewayA)).toMatchObject({ theme: "knot", navCollapsed: false });
  });
});

describe("standalone document Gateway settings", () => {
  beforeEach(() => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/openclaw/approve/exec%3A1",
    });
    setControlUiBasePath("/openclaw");
  });

  it("binds to the serving Gateway without persisting a selection", () => {
    const remote = makeSettings("wss://remote.example:8443", {
      sessionKey: "agent:remote:main",
      lastActiveSessionKey: "agent:remote:main",
    });
    const sessionCredential = ["page", "session", "credential"].join("-");
    persistSessionToken(expectedGatewayUrl("/openclaw"), sessionCredential);
    const before = [...Array(localStorage.length)].map((_, index) => localStorage.key(index));

    expect(resolvePageGatewaySettings(remote)).toMatchObject({
      gatewayUrl: expectedGatewayUrl("/openclaw"),
      token: sessionCredential,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual(
      before,
    );
  });

  it("does not graft query-tenant appearance into the serving Gateway", () => {
    const pageGateway = expectedGatewayUrl("/openclaw");
    const tenantGateway = `${pageGateway}?tenant=a`;
    selectGatewaySettings(pageGateway, {
      theme: "dash",
      navCollapsed: true,
      sidebarEntries: ["route:usage"],
    });
    const tenant = selectGatewaySettings(tenantGateway, {
      theme: "knot",
      navCollapsed: false,
      sidebarEntries: ["route:chat"],
    });

    expect(resolvePageGatewaySettings(tenant)).toMatchObject({
      gatewayUrl: pageGateway,
      theme: "dash",
      navCollapsed: true,
      sidebarEntries: ["route:usage"],
    });
    expect(loadSettings(tenantGateway)).toMatchObject({ theme: "knot", navCollapsed: false });
  });
});
