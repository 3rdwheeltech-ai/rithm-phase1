import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSessionTeardown } from "./session";
import { qk } from "./queryClient";
import { useAuth } from "../store/auth";
import { usePlayer } from "../store/player";
import type { TrackSummary } from "../types/api";

function track(id: string): TrackSummary {
  return {
    id,
    prompt: "warm lo-fi piano",
    title: null,
    genre: "Lo-Fi",
    mood: "Calm",
    bpm: 85,
    vocal: false,
    length_seconds: 30,
    mp3_url: `https://s3.example/${id}.mp3`,
    created_at: "2026-08-04T12:00:00Z",
  };
}

function anon() {
  useAuth.setState({
    idToken: null,
    refreshToken: null,
    email: null,
    user: null,
    status: "anon",
  });
}

function authAs(sub: string, email: string) {
  useAuth.setState({
    idToken: `${sub}.id.token`,
    refreshToken: `${sub}.refresh.token`,
    email,
    user: { sub, email },
    status: "authed",
  });
}

let queryClient: QueryClient;
let unsubscribe: () => void;

beforeEach(() => {
  anon();
  usePlayer.getState().reset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  unsubscribe = installSessionTeardown(queryClient);
});

afterEach(() => {
  unsubscribe();
});

function seed() {
  queryClient.setQueryData(qk.me, { profile: { onboarding: true } });
  queryClient.setQueryData(qk.tracksList(), { pages: [{ tracks: [track("t1")] }] });
  usePlayer.getState().play(track("t1"), [track("t1")]);
}

describe("installSessionTeardown", () => {
  it("clears the query cache and the player on logout", () => {
    authAs("sub-a", "a@example.com");
    seed();

    useAuth.getState().logout();

    expect(queryClient.getQueryData(qk.me)).toBeUndefined();
    expect(queryClient.getQueryData(qk.tracksList())).toBeUndefined();
    expect(usePlayer.getState()).toMatchObject({
      track: null,
      queue: [],
      isPlaying: false,
      position: 0,
    });
  });

  it("clears when a second account signs in without an intervening logout", () => {
    authAs("sub-a", "a@example.com");
    seed();

    authAs("sub-b", "b@example.com");

    expect(queryClient.getQueryData(qk.me)).toBeUndefined();
    expect(queryClient.getQueryData(qk.tracksList())).toBeUndefined();
    expect(usePlayer.getState().track).toBeNull();
  });

  it("does not clear on a same-user token refresh", () => {
    authAs("sub-a", "a@example.com");
    seed();

    useAuth.getState().setIdToken("sub-a.fresh.id.token", { sub: "sub-a", email: "a@example.com" });

    expect(queryClient.getQueryData(qk.me)).toBeDefined();
    expect(queryClient.getQueryData(qk.tracksList())).toBeDefined();
    expect(usePlayer.getState().track).not.toBeNull();
  });

  it("is a no-op for the anon-to-anon transition during bootstrap", () => {
    seed();
    // No account was ever signed in, so `identity` is null both before and
    // after — clearing here would just be wasted work on every cold load.
    useAuth.setState({ status: "anon" });

    expect(queryClient.getQueryData(qk.me)).toBeDefined();
    expect(usePlayer.getState().track).not.toBeNull();
  });
});
