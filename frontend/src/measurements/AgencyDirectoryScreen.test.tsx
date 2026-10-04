import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyDirectory } from "./AgencyDirectoryScreen";
import { installTestAgencyStorage } from "./agencyDirectory.test-support";
import { agencyDirectoryStorageKey } from "./agencyDirectory";

const auth = vi.hoisted(() => ({ org: { id: "org-1" } as { id: string } | null, editable: true }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: auth.org, can: (action: string) => action === "manageSettings" && auth.editable }) }));
const key = agencyDirectoryStorageKey("org-1")!;
const existing = { id: "agency-1", name: "Saved agency", role: "Agent", representative: "Ada", active: true };
function seed() { window.localStorage.setItem(key, JSON.stringify({ version: 1, organizationId: "org-1", agencies: [existing] })); }
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { installTestAgencyStorage(); auth.org = { id: "org-1" }; auth.editable = true; });

describe("agency setup screen", () => {
  it("saves reusable custom agency details, edits, archives and reactivates without API requests", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<AgencyDirectory />);
    const user = userEvent.setup();
    expect(screen.getByText(/UI preview · saved on this browser/)).toBeInTheDocument();
    expect(screen.getByText("No agencies set up yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Agency name"), "Joint Survey Team");
    await user.selectOptions(screen.getByLabelText("Agency role"), "custom");
    await user.type(screen.getByLabelText("Custom role"), "Cargo inspector");
    await user.type(screen.getByLabelText("Default representative"), "Grace");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Joint Survey Team saved."));
    expect(screen.getByLabelText("Agency name")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Edit Joint Survey Team" }));
    expect(screen.getByLabelText("Custom role")).toHaveValue("Cargo inspector");
    await user.clear(screen.getByLabelText("Default representative"));
    await user.type(screen.getByLabelText("Default representative"), "Bola");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    await waitFor(() => expect(screen.getByText("Default representative: Bola")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Archive Joint Survey Team" }));
    expect(screen.getByText("No active agencies.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Show agencies"), "inactive");
    await user.click(screen.getByRole("button", { name: "Reactivate Joint Survey Team" }));
    expect(screen.getByText("No inactive agencies.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Show agencies"), "all");
    expect(within(screen.getByRole("listitem")).getByText("Active", { exact: true })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(key)!).agencies).toEqual([expect.objectContaining({ name: "Joint Survey Team", role: "Cargo inspector", representative: "Bola", active: true })]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows read-only entries without edit, archive or save controls to non-admin staff", () => {
    seed(); auth.editable = false;
    render(<AgencyDirectory />);
    expect(screen.getByText("Saved agency")).toBeInTheDocument();
    expect(screen.getByText(/Only staff with settings management permission/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agency name")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(key)!).agencies).toEqual([existing]);
  });

  it("keeps entered details when persistence fails and displays the error", async () => {
    render(<AgencyDirectory />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Agency name"), "Unsaved agency");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Quota"); });
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your changes have not been saved.");
    expect(screen.getByLabelText("Agency name")).toHaveValue("Unsaved agency");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("No agencies set up yet.")).toBeInTheDocument();
  });

  it("rejects duplicate entries without clearing the draft or overwriting the original", async () => {
    seed(); render(<AgencyDirectory />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Agency name"), "saved agency");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("Agency name")).toHaveValue("saved agency");
    expect(JSON.parse(window.localStorage.getItem(key)!).agencies).toEqual([existing]);
  });

  it("drops the editing form and data when the organization changes or becomes unavailable", async () => {
    seed(); const page = render(<AgencyDirectory />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Saved agency" }));
    auth.org = { id: "org-2" }; page.rerender(<AgencyDirectory />);
    expect(screen.getByLabelText("Agency name")).toHaveValue("");
    expect(screen.queryByText("Saved agency")).not.toBeInTheDocument();
    auth.org = null; page.rerender(<AgencyDirectory />);
    expect(screen.queryByLabelText("Agency name")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("organization is loaded");
  });
});
