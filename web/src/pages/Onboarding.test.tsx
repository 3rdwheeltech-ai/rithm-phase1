import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, jsonResponse } from "../test-utils";
import { useAuth } from "../store/auth";
import Onboarding from "./Onboarding";
import type { MeResponse } from "../types/profile";

const EMPTY_PREFERENCES = {
  experience_level: null,
  genres: [],
  moods: [],
  primary_intent: null,
  typical_length: null,
};

function me(completedAt: string | null): MeResponse {
  return {
    user_id: "u-1",
    email: "user@example.com",
    is_admin: false,
    profile: {
      version: 1,
      display_name: "Ada",
      onboarding: { completed_at: completedAt, skipped: false },
      preferences: EMPTY_PREFERENCES,
    },
  };
}

function renderOnboarding() {
  return renderWithProviders(
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/" element={<p>studio</p>} />
    </Routes>,
    "/onboarding",
  );
}

/** The body of the Nth fetch call, parsed. */
function bodyOf(mock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = mock.mock.calls[index]![1] as RequestInit;
  return JSON.parse(init.body as string);
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

describe("Onboarding", () => {
  it("asks one question at a time and advances on Continue", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me(null)));
    renderOnboarding();

    expect(await screen.findByText("Where are you at?")).toBeInTheDocument();
    expect(screen.queryByText("What do you make?")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("What do you make?")).toBeInTheDocument();
    expect(screen.getByText("2 of 5")).toBeInTheDocument();
  });

  it("goes back to the previous question", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me(null)));
    renderOnboarding();

    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Where are you at?")).toBeInTheDocument();
  });

  it("has no Back button on the first question", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me(null)));
    renderOnboarding();

    await screen.findByText("Where are you at?");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("skips with every preference empty, and leaves the studio reachable", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? jsonResponse(200, me("2026-08-15T10:04:11Z").profile)
          : jsonResponse(200, me(null)),
      ),
    );
    renderOnboarding();

    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(screen.getByText("studio")).toBeInTheDocument());
    const patch = fetchMock.mock.calls.findIndex(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    // The keys are PRESENT and empty, not absent — that is what makes Settings
    // render the same groups for a skipper as for anyone else.
    expect(bodyOf(fetchMock, patch)).toEqual({
      preferences: EMPTY_PREFERENCES,
      onboarding_action: "skip",
    });
  });

  it("sends the answers and completes on Finish", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? jsonResponse(200, me("2026-08-15T10:04:11Z").profile)
          : jsonResponse(200, me(null)),
      ),
    );
    renderOnboarding();

    // Step 1 is single-select, so picking auto-advances to genres.
    await userEvent.click(await screen.findByRole("button", { name: "Hobbyist" }));
    await screen.findByText("What do you make?");

    await userEvent.click(screen.getByRole("button", { name: "Lo-Fi" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("And how should it feel?");
    await userEvent.click(screen.getByRole("button", { name: "Calm" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await userEvent.click(await screen.findByRole("button", { name: "Content & social" }));
    await screen.findByText("How long, usually?");
    await userEvent.click(screen.getByRole("button", { name: "Standard — around 90s" }));

    await userEvent.click(await screen.findByRole("button", { name: "Finish" }));

    await waitFor(() => expect(screen.getByText("studio")).toBeInTheDocument());
    const patch = fetchMock.mock.calls.findIndex(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(bodyOf(fetchMock, patch)).toEqual({
      preferences: {
        experience_level: "hobbyist",
        genres: ["Lo-Fi"],
        moods: ["Calm"],
        primary_intent: "content",
        typical_length: "standard",
      },
      onboarding_action: "complete",
    });
  });

  it("redirects an already-onboarded user away instead of asking twice", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, me("2026-08-15T10:04:11Z")));
    renderOnboarding();

    expect(await screen.findByText("studio")).toBeInTheDocument();
  });
});
