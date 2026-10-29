import { describe, expect, it } from "vitest";
import {
  applyDenyOverrides,
  assertCompatibleRoles,
  assertNotSelfApproval,
  assertNotSelfApprovalOfWork,
  assertRoleIsRemovable,
  assertRoleNotInUse,
  assertUserStatusTransition,
  classifyHighRiskChange,
  explainPermission,
  isSelfPrivilegeEscalation,
  requiresSecondApproval,
} from "./policies";
import { isIamError } from "./errors";
import type { EffectivePermission } from "./types";
import { clearsClassification, mayLeaveForAi } from "./classification";

/**
 * Domain unit tests. No database, no framework: these are pure rules, which is
 * the point of keeping them in the domain layer.
 */

const perm = (
  resource: string,
  action: string,
  scope: EffectivePermission["scope"] = "assigned",
  ceiling: EffectivePermission["classificationCeiling"] = "CONFIDENTIAL",
  source = "role:investigator",
): EffectivePermission => ({
  resource,
  action,
  scope,
  classificationCeiling: ceiling,
  source,
});

describe("classification", () => {
  it("orders the five levels correctly", () => {
    expect(clearsClassification("RESTRICTED", "CONFIDENTIAL")).toBe(true);
    expect(clearsClassification("CONFIDENTIAL", "RESTRICTED")).toBe(false);
    expect(clearsClassification("PUBLIC", "PUBLIC")).toBe(true);
    expect(clearsClassification("STRICTLY_RESTRICTED", "PUBLIC")).toBe(true);
  });

  it("only lets PUBLIC and INTERNAL leave for a third-party AI provider", () => {
    // PRD 22.4: everything above INTERNAL is blocked at the gateway.
    expect(mayLeaveForAi("PUBLIC")).toBe(true);
    expect(mayLeaveForAi("INTERNAL")).toBe(true);
    expect(mayLeaveForAi("CONFIDENTIAL")).toBe(false);
    expect(mayLeaveForAi("RESTRICTED")).toBe(false);
    expect(mayLeaveForAi("STRICTLY_RESTRICTED")).toBe(false);
  });
});

describe("two-person rule", () => {
  it("treats every listed high-risk kind as needing a second approver", () => {
    expect(requiresSecondApproval("grant_administrator")).toBe(true);
    expect(requiresSecondApproval("grant_strictly_restricted")).toBe(true);
    expect(requiresSecondApproval("change_audit_settings")).toBe(true);
    expect(requiresSecondApproval("purge_record")).toBe(true);
  });

  it("classifies a proposed change into the right high-risk kind", () => {
    expect(classifyHighRiskChange({ grantsAdministratorRole: true })).toBe(
      "grant_administrator",
    );
    expect(classifyHighRiskChange({ grantsClearance: "STRICTLY_RESTRICTED" })).toBe(
      "grant_strictly_restricted",
    );
    expect(classifyHighRiskChange({ grantsActions: ["view", "delete"] })).toBe(
      "grant_delete",
    );
    expect(classifyHighRiskChange({ grantsActions: ["export"] })).toBe(
      "grant_export_all",
    );
    expect(classifyHighRiskChange({ purgesRecord: true })).toBe("purge_record");
  });

  it("treats an ordinary change as not high risk", () => {
    expect(
      classifyHighRiskChange({
        grantsClearance: "CONFIDENTIAL",
        grantsActions: ["view", "edit"],
      }),
    ).toBeNull();
  });

  it("flags an administrator raising their own privileges", () => {
    expect(isSelfPrivilegeEscalation("u1", "u1", "grant_administrator")).toBe(true);
    expect(isSelfPrivilegeEscalation("u1", "u2", "grant_administrator")).toBe(false);
    // Not high risk at all, so not escalation.
    expect(isSelfPrivilegeEscalation("u1", "u1", null)).toBe(false);
  });

  it("rejects self-approval", () => {
    expect(() => assertNotSelfApproval("u1", "u1")).toThrow(/different administrator/i);
    expect(() => assertNotSelfApproval("u1", "u2")).not.toThrow();
  });

  it("uses a stable error code for self-approval", () => {
    try {
      assertNotSelfApproval("u1", "u1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isIamError(error) && error.code).toBe("self_approval_forbidden");
    }
  });
});

describe("no approving your own work", () => {
  it("blocks the author from approving", () => {
    expect(() => assertNotSelfApprovalOfWork("u1", "u1", "report")).toThrow(
      /authored this report/i,
    );
  });

  it("allows a different person to approve", () => {
    expect(() => assertNotSelfApprovalOfWork("u2", "u1", "report")).not.toThrow();
  });

  it("allows approval when the author is unknown", () => {
    expect(() => assertNotSelfApprovalOfWork("u1", null, "plan")).not.toThrow();
  });
});

describe("separation of duties", () => {
  const incompatibilities = [
    { roleAId: "finance", roleBId: "administrator", reason: "Finance must not administer." },
  ];

  it("rejects an incompatible pair held together", () => {
    expect(() =>
      assertCompatibleRoles(["finance", "administrator"], incompatibilities),
    ).toThrow(/must not administer/i);
  });

  it("allows either role on its own", () => {
    expect(() => assertCompatibleRoles(["finance"], incompatibilities)).not.toThrow();
    expect(() =>
      assertCompatibleRoles(["administrator", "supervisor"], incompatibilities),
    ).not.toThrow();
  });

  it("detects the pair regardless of the order held", () => {
    expect(() =>
      assertCompatibleRoles(["administrator", "finance"], incompatibilities),
    ).toThrow();
  });
});

describe("user status transitions", () => {
  it("permits the documented lifecycle", () => {
    expect(() => assertUserStatusTransition("invited", "active")).not.toThrow();
    expect(() => assertUserStatusTransition("active", "suspended")).not.toThrow();
    expect(() => assertUserStatusTransition("suspended", "active")).not.toThrow();
    expect(() => assertUserStatusTransition("deactivated", "archived")).not.toThrow();
  });

  it("rejects a transition out of archived", () => {
    expect(() => assertUserStatusTransition("archived", "active")).toThrow(
      /cannot move from archived to active/i,
    );
  });

  it("rejects skipping straight from invited to suspended", () => {
    expect(() => assertUserStatusTransition("invited", "suspended")).toThrow();
  });

  it("treats a no-op transition as allowed", () => {
    expect(() => assertUserStatusTransition("active", "active")).not.toThrow();
  });
});

describe("role protection", () => {
  it("refuses to remove the baseline role", () => {
    expect(() =>
      assertRoleIsRemovable({ isBaseline: true, name: "Employee" }),
    ).toThrow(/baseline role/i);
  });

  it("allows removing an ordinary role", () => {
    expect(() =>
      assertRoleIsRemovable({ isBaseline: false, name: "Investigator" }),
    ).not.toThrow();
  });

  it("refuses to delete a role that still has members", () => {
    expect(() => assertRoleNotInUse({ name: "Supervisor" }, 3)).toThrow(
      /held by 3 user\(s\)/i,
    );
  });

  it("allows deleting an empty role", () => {
    expect(() => assertRoleNotInUse({ name: "Supervisor" }, 0)).not.toThrow();
  });
});

describe("deny overrides allow", () => {
  it("removes the denied resource and action entirely", () => {
    const granted = [perm("evidence", "upload"), perm("cases", "view")];
    const result = applyDenyOverrides(granted, [
      { resource: "evidence", action: "upload" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].resource).toBe("cases");
  });

  it("removes a grant held at a different scope", () => {
    // A narrower surviving grant would make the deny look applied while
    // leaving a hole, so the deny is matched on resource and action only.
    const granted = [perm("cases", "edit", "all"), perm("cases", "edit", "assigned")];
    const result = applyDenyOverrides(granted, [{ resource: "cases", action: "edit" }]);

    expect(result).toHaveLength(0);
  });

  it("returns the list untouched when nothing is denied", () => {
    const granted = [perm("cases", "view")];
    expect(applyDenyOverrides(granted, [])).toEqual(granted);
  });
});

describe("explainPermission, for the why-can-they viewer", () => {
  const base = {
    clearance: "CONFIDENTIAL" as const,
    isAdministrator: false,
    status: "active" as const,
  };

  it("names the role responsible for an allow", () => {
    const result = explainPermission([perm("cases", "view", "team", "CONFIDENTIAL", "role:supervisor")], {
      ...base,
      resource: "cases",
      action: "view",
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe("role:supervisor");
    expect(result.reason).toMatch(/role:supervisor grants view on cases at scope team/i);
  });

  it("says plainly when nothing grants it", () => {
    const result = explainPermission([perm("cases", "view")], {
      ...base,
      resource: "evidence",
      action: "delete",
    });

    expect(result.allowed).toBe(false);
    expect(result.source).toBeNull();
    expect(result.reason).toMatch(/no active role or override grants delete on evidence/i);
  });

  it("explains a ceiling that is too low", () => {
    const result = explainPermission(
      [perm("evidence", "view", "assigned", "CONFIDENTIAL", "role:investigator")],
      { ...base, clearance: "STRICTLY_RESTRICTED", resource: "evidence", action: "view", classification: "RESTRICTED" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/only up to CONFIDENTIAL, below the required RESTRICTED/i);
    expect(result.source).toBe("role:investigator");
  });

  it("explains a personal clearance that is too low even though the role allows it", () => {
    const result = explainPermission(
      [perm("evidence", "view", "team", "RESTRICTED", "role:supervisor")],
      { ...base, clearance: "CONFIDENTIAL", resource: "evidence", action: "view", classification: "RESTRICTED" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/personal clearance is CONFIDENTIAL/i);
    expect(result.reason).toMatch(/never granted by a role/i);
  });

  it("explains the administrator wildcard", () => {
    const result = explainPermission([], {
      ...base,
      isAdministrator: true,
      resource: "anything",
      action: "delete",
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe("role:administrator");
    expect(result.reason).toMatch(/wildcard grant/i);
  });

  it("explains a suspended account before looking at permissions", () => {
    const result = explainPermission([perm("cases", "view")], {
      ...base,
      status: "suspended",
      resource: "cases",
      action: "view",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/account is suspended/i);
  });

  it("explains a locked account", () => {
    const result = explainPermission([perm("cases", "view")], {
      ...base,
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
      resource: "cases",
      action: "view",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/locked after repeated failed sign-ins/i);
  });

  it("ignores an expired lock", () => {
    const result = explainPermission([perm("cases", "view")], {
      ...base,
      lockedUntil: new Date(Date.now() - 60_000).toISOString(),
      resource: "cases",
      action: "view",
    });

    expect(result.allowed).toBe(true);
  });

  it("matches a wildcard resource and action", () => {
    const result = explainPermission([perm("*", "*", "all", "STRICTLY_RESTRICTED", "role:custom")], {
      ...base,
      clearance: "STRICTLY_RESTRICTED",
      resource: "cases",
      action: "delete",
      classification: "RESTRICTED",
    });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe("role:custom");
  });

  it("prefers the broadest scope when several roles grant the same thing", () => {
    const result = explainPermission(
      [
        perm("cases", "view", "assigned", "CONFIDENTIAL", "role:investigator"),
        perm("cases", "view", "all", "CONFIDENTIAL", "role:operations_manager"),
      ],
      { ...base, resource: "cases", action: "view" },
    );

    expect(result.source).toBe("role:operations_manager");
    expect(result.reason).toMatch(/scope all/i);
  });
});
