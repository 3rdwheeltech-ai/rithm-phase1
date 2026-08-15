import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, jsonResponse } from "../test-utils";
import { useAuth } from "../store/auth";
import Settings from "./Settings";
import type { MeResponse } from "../types/profile";

const ME: MeResponse = {
  user_id: "u-1",
  email: "ada@example.com",
  is_admin: false,
  profile: {
    version: 1,
    display_name: "Ada",
    onboarding: { completed_at: "2026-08-15T10:04:11Z", skipped: false },
    preferences: {
      experience_level: "hobbyist",
      genres: ["Lo-Fi"],
      moods: [],
      primary_intent: null,
      typical_length: null,
    },
  },
};

function patchBody(mock: ReturnType<typeof vi.fn>): unknown {
  const call = mock.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
  );
  return JSON.parse((call![1] as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useAuth.setState({
    idToken: "id.token",
    refreshToken: "refresh",
    email: "ada@example.com",
    user: { sub: "sub-1", email: "ada@example.com" },
    status: "authed",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings", () => {
  it("shows what the user picked at registration, pre-filled", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ME));
    renderWithProviders(<Settings />, "/settings");

    expect(await screen.findByDisplayValue("Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hobbyist" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Lo-Fi" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the email read-only — it is the sign-in", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ME));
    renderWithProviders(<Settings />, "/settings");

    const email = await screen.findByDisplayValue("ada@example.com");
    expect(email).toHaveAttribute("readonly");
  });

  it("hides the save bar until something actually changes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ME));
    renderWithProviders(<Settings />, "/settings");

    await screen.findByDisplayValue("Ada");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Calm" }));

    expect(await screen.findByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("patches ONLY the keys that changed", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(200, init?.method === "PATCH" ? ME.profile : ME),
      ),
    );
    renderWithProviders(<Settings />, "/settings");

    await screen.findByDisplayValue("Ada");
    await userEvent.click(screen.getByRole("button", { name: "Calm" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    // No display_name, no genres — the server merges per key, so sending only
    // the diff is what keeps two open tabs from clobbering each other.
    expect(patchBody(fetchMock)).toEqual({ preferences: { moods: ["Calm"] } });
  });

  it("includes an edited display name in the patch", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(200, init?.method === "PATCH" ? ME.profile : ME),
      ),
    );
    renderWithProviders(<Settings />, "/settings");

    const name = await screen.findByDisplayValue("Ada");
    await userEvent.clear(name);
    await userEvent.type(name, "Grace");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    expect(patchBody(fetchMock)).toEqual({ display_name: "Grace" });
  });

  it("discards changes back to the server's document", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ME));
    renderWithProviders(<Settings />, "/settings");

    await screen.findByDisplayValue("Ada");
    await userEvent.click(screen.getByRole("button", { name: "Calm" }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard" }));

    expect(screen.getByRole("button", { name: "Calm" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});
