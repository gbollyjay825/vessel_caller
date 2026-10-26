import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyDirectory } from "./AgencyDirectoryScreen";
import { request } from "../lib/api";
import type { AgencyProfile } from "./agencyDirectory";

const auth = vi.hoisted(() => ({ org: { id: "org-1" } as { id: string } | null, editable: true }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: auth.org, can: () => auth.editable }) }));
vi.mock("../lib/api", async importOriginal => ({ ...await importOriginal<typeof import("../lib/api")>(), request: vi.fn() }));
let rows: AgencyProfile[];
let failSave: boolean;
const existing = { id: "agency-1", name: "Saved agency", role: "Agent", representative: "Ada", active: true, version: 1 };
beforeEach(() => {
  auth.org = { id: "org-1" }; auth.editable = true; rows = []; failSave = false;
  vi.mocked(request).mockImplementation(async (_url, options) => {
    if (!options?.method) return { agencies: structuredClone(rows) };
    if (failSave) throw new Error("Save failed; try again.");
    const input = JSON.parse(options.body as string) as AgencyProfile;
    if (!input.id && rows.some(row => row.name.toLowerCase() === input.name.toLowerCase())) throw new Error("Agency already exists");
    const agency = { ...input, id: input.id ?? "created-1", version: (input.version ?? 0) + 1 };
    rows = [...rows.filter(row => row.id !== agency.id), agency];
    return { agency };
  });
});

describe("organization agency directory", () => {
  it("saves, edits and archives through the server and reloads persisted agencies", async () => {
    const page = render(<AgencyDirectory />); const user = userEvent.setup();
    await screen.findByText("No agencies set up yet.");
    expect(screen.getByText(/shared with its authorized users/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Agency name"), "Joint Survey Team");
    await user.type(screen.getByLabelText("Default representative"), "Grace");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    await screen.findByText("Joint Survey Team saved.");
    expect(request).toHaveBeenCalledWith("/api/agencies", expect.objectContaining({ method: "POST" }));
    page.unmount(); render(<AgencyDirectory />);
    await screen.findByText("Joint Survey Team");
    await user.click(screen.getByRole("button", { name: "Edit Joint Survey Team" }));
    await user.clear(screen.getByLabelText("Default representative"));
    await user.type(screen.getByLabelText("Default representative"), "Bola");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    await screen.findByText("Default representative: Bola");
    await user.click(screen.getByRole("button", { name: "Archive Joint Survey Team" }));
    await screen.findByText("No active agencies.");
    expect(rows[0].active).toBe(false);
    expect(request).toHaveBeenCalledWith("/api/agencies/created-1", expect.objectContaining({ method: "PATCH" }));
  });
  it("shows read-only entries without mutation controls", async () => {
    rows = [existing]; auth.editable = false; render(<AgencyDirectory />);
    await screen.findByText("Saved agency");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agency name")).not.toBeInTheDocument();
  });
  it("preserves input and displays a failed server save", async () => {
    render(<AgencyDirectory />); const user = userEvent.setup();
    await screen.findByText("No agencies set up yet.");
    await user.type(screen.getByLabelText("Agency name"), "Unsaved agency");
    failSave = true;
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Agency name")).toHaveValue("Unsaved agency");
    expect(screen.queryByText("Unsaved agency saved.")).not.toBeInTheDocument();
  });
  it("displays server conflict without replacing the saved agency", async () => {
    rows = [existing]; render(<AgencyDirectory />); const user = userEvent.setup();
    await screen.findByText("Saved agency");
    await user.type(screen.getByLabelText("Agency name"), "saved agency");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(rows).toEqual([existing]);
  });
  it("clears earlier organization data and form on organization changes", async () => {
    rows = [existing]; const page = render(<AgencyDirectory />);
    await screen.findByText("Saved agency");
    await userEvent.click(screen.getByRole("button", { name: "Edit Saved agency" }));
    auth.org = { id: "org-2" }; rows = []; page.rerender(<AgencyDirectory />);
    expect(screen.getByLabelText("Agency name")).toHaveValue("");
    await waitFor(() => expect(screen.queryByText("Saved agency")).not.toBeInTheDocument());
    auth.org = null; page.rerender(<AgencyDirectory />);
    expect(screen.queryByLabelText("Agency name")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("organization is loaded");
  });
});
