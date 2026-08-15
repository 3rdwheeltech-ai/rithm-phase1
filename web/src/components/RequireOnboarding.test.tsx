import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, jsonResponse } from "../test-utils";
import { useAuth } from "../store/auth";
import RequireOnboarding from "./RequireOnboarding";
import type { MeResponse } from "../types/profile";

function me(completedAt: string | null): MeResponse {
  return {
    user_id: "u-1",
    email: "user@example.com",
    is_admin: false,
    profile: {
      version: 1,
      display_name: "Ada",
      onboarding: { completed_at: completedAt, skipped: false },
      preferences: {
        experience_level: null,
        genres: [],
        moods: [],
        primary_intent: null,
        typical_length: null,
      },
    },
  };
}

function renderGate() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/"
        element={
          <RequireOnboarding>
            <p>studio</p>
          </RequireOnboarding>
        }
      />
      <Route path="/onboarding" element={<p>onboarding</p>} />
    </Routes>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useAuth.setState({
    idToken: "id.token",
    refreshToken: "refresh",
    email: "user@example.com",
    user: { sub: "sub-1", email: "user@example.com" },
    status: "authed",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RequireOnboarding", () => {
  it("redirects to /onboarding when the flow has never run", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me(null)));
    renderGate();

    expect(await screen.findByText("onboarding")).toBeInTheDocument();
  });

  it("renders the shell once onboarding is complete", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me("2026-08-15T10:04:11Z")));
    renderGate();

    expect(await screen.findByText("studio")).toBeInTheDocument();
  });

  it("shows a spinner rather than the shell while the profile is loading", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderGate();

    expect(screen.getByRole("generic", { busy: true })).toBeInTheDocument();
    expect(screen.queryByText("studio")).not.toBeInTheDocument();
  });

  it("fails OPEN on a server error — a /me outage must not lock users out", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { title: "boom" }));
    renderGate();

    await waitFor(() => expect(screen.getByText("studio")).toBeInTheDocument());
  });

  it("does not fetch until the session has been restored", () => {
    useAuth.setState({ status: "loading" });
    fetchMock.mockResolvedValue(jsonResponse(200, me(null)));
    renderGate();

    // An anonymous GET /me is a hard 401 the request layer will not replay.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
