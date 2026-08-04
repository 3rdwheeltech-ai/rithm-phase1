import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorToast, { errorMessage } from "./ErrorToast";
import { ApiError } from "../lib/api";

function apiError(status: number, extras: Record<string, unknown> = {}, detail = "") {
  return new ApiError({ status, detail, title: "Problem", requestId: "req-9", extras });
}

describe("errorMessage", () => {
  it("builds the 429 copy from the numeric extras, not from prose", () => {
    const message = errorMessage(
      apiError(429, { retry_after_seconds: 3600, used: 20, limit: 20 }, "Rate limit exceeded"),
    );
    expect(message?.message).toBe(
      "You've used all 20 generations for today. Try again in 1 hour.",
    );
  });

  it("humanises a short retry window in minutes", () => {
    const message = errorMessage(apiError(429, { retry_after_seconds: 180, limit: 20 }));
    expect(message?.message).toContain("3 minutes");
  });

  it("survives a 429 with no extras at all", () => {
    const message = errorMessage(apiError(429));
    expect(message?.message).toBe("You've used all your generations for today. Try again later.");
  });

  it("tells the user a 503 is safe to retry", () => {
    // The job row is already FAILED, so a retry is a clean new submission.
    expect(errorMessage(apiError(503))?.message).toBe(
      "We couldn't queue that one. Please try again.",
    );
  });

  it("renders a 400 detail verbatim — those are actionable by construction", () => {
    const message = errorMessage(
      apiError(400, {}, "Audio-reference refinement is not available yet."),
    );
    expect(message?.message).toBe("Audio-reference refinement is not available yet.");
  });

  it("is silent on a 401 because the client is already logging them out", () => {
    expect(errorMessage(apiError(401))).toBeNull();
  });

  it("carries request_id on a 5xx so support can find it in CloudWatch", () => {
    const message = errorMessage(apiError(500));
    expect(message?.message).toBe("Something went wrong on our side.");
    expect(message?.requestId).toBe("req-9");
  });

  it("returns null when there is no error", () => {
    expect(errorMessage(null)).toBeNull();
  });
});

describe("ErrorToast", () => {
  it("renders nothing for a silent error", () => {
    const { container } = render(<ErrorToast error={apiError(401)} onDismiss={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the message and shows the reference on a 5xx", () => {
    render(<ErrorToast error={apiError(500)} onDismiss={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on our side.");
    expect(screen.getByText("Reference: req-9")).toBeInTheDocument();
  });

  it("dismisses on the close button", async () => {
    const onDismiss = vi.fn();
    render(<ErrorToast error={apiError(503)} onDismiss={onDismiss} />);
    screen.getByRole("button", { name: "Dismiss" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
