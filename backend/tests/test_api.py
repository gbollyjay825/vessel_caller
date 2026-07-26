"""End-to-end API tests: auth, roles, the vessel→invoice flow, money-snapshot
integrity, rev-polling, and analytics-from-DB."""
from tests.conftest import auth, register


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_unauthenticated_state_is_blocked(client):
    assert client.get("/api/state").status_code in (401, 403)


def test_register_login_me(client):
    reg = register(client)
    assert reg["user"]["role"] == "Admin"
    # duplicate email
    assert client.post("/api/auth/register", json={
        "name": "x", "email": "admin@acme.test", "password": "supersecret", "orgName": "Dup"
    }).status_code == 409
    # wrong password
    assert client.post("/api/auth/login", json={"email": "admin@acme.test", "password": "nope"}).status_code == 401
    ok = client.post("/api/auth/login", json={"email": "admin@acme.test", "password": "supersecret"})
    assert ok.status_code == 200 and ok.json()["token"]
    me = client.get("/api/auth/me", headers=auth(reg["token"]))
    assert me.status_code == 200 and me.json()["org"]["name"] == "Acme Marine"


def test_role_enforced_server_side(client):
    reg = register(client, email="a@r.test", org="Roles Co")
    tok = reg["token"]
    # add a Viewer
    m = client.post("/api/organization/members", headers=auth(tok), json={
        "name": "View Er", "email": "viewer@r.test", "password": "viewerpass", "role": "Viewer"})
    assert m.status_code == 201
    vtok = client.post("/api/auth/login", json={"email": "viewer@r.test", "password": "viewerpass"}).json()["token"]
    # viewer cannot register a call
    denied = client.post("/api/vessel-calls", headers=auth(vtok), json={
        "vesselName": "MT X", "reference": "ROT-2026-9001", "nrt": 1000})
    assert denied.status_code == 403


def _make_call(client, tok, ref="ROT-2026-0500", nrt=50000):
    r = client.post("/api/vessel-calls", headers=auth(tok), json={
        "vesselName": "MT Sea Eagle", "reference": ref, "type": "Tanker", "nrt": nrt})
    assert r.status_code == 201, r.text
    return r.json()["call"]["id"]


def test_inspection_issues_snapshotted_invoice(client):
    tok = register(client, email="b@f.test", org="Flows Co")["token"]
    call_id = _make_call(client, tok, ref="ROT-2026-0501", nrt=50000)
    # duplicate rotation -> 409
    assert client.post("/api/vessel-calls", headers=auth(tok), json={
        "vesselName": "y", "reference": "ROT-2026-0501", "nrt": 1}).status_code == 409

    ins = client.post("/api/inspections", headers=auth(tok), json={
        "callId": call_id, "cargoType": "Liquid", "product": "PMS", "reconciledTonnage": 48000,
        "jetty": {"type": "International", "category": None, "name": "UNICEM Jetty"},
        "status": "completed"})
    assert ins.status_code == 201, ins.text
    inv = ins.json()["invoice"]
    assert inv["dues"] == 211500.0            # 50000 * 4.23
    assert inv["rate"] == 4.23 and inv["status"] == "unpaid"

    # record payment -> amount stamped from dues, status paid
    pay = client.put(f"/api/invoices/{inv['id']}", headers=auth(tok), json={
        "status": "paid", "payment": {"paidOn": "2026-07-01", "method": "Bank transfer", "reference": "NPA-1"}})
    assert pay.status_code == 200
    assert pay.json()["invoice"]["payment"]["amount"] == 211500.0
    assert pay.json()["invoice"]["status"] == "paid"


def test_rate_change_does_not_rewrite_issued_invoice(client):
    tok = register(client, email="c@s.test", org="Snap Co")["token"]
    call_id = _make_call(client, tok, ref="ROT-2026-0502", nrt=50000)
    ins = client.post("/api/inspections", headers=auth(tok), json={
        "callId": call_id, "cargoType": "Liquid", "product": "AGO", "reconciledTonnage": 40000,
        "jetty": {"type": "International", "category": None, "name": "UNICEM Jetty"}, "status": "completed"})
    inv_id = ins.json()["invoice"]["id"]
    # raise the international rate dramatically
    up = client.put("/api/settings", headers=auth(tok), json={
        "liquidDuesRates": {"government": 1.68, "private": 2.88, "international": 9.99}})
    assert up.status_code == 200
    state = client.get("/api/state", headers=auth(tok)).json()
    inv = next(v for v in state["invoices"] if v["id"] == inv_id)
    assert inv["dues"] == 211500.0            # unchanged despite the new 9.99 rate


def test_rev_polling(client):
    tok = register(client, email="d@p.test", org="Poll Co")["token"]
    rev = client.get("/api/state", headers=auth(tok)).json()["rev"]
    same = client.get(f"/api/state?rev={rev}", headers=auth(tok)).json()
    assert same == {"changed": False, "rev": rev}
    _make_call(client, tok, ref="ROT-2026-0503")
    moved = client.get(f"/api/state?rev={rev}", headers=auth(tok)).json()
    assert moved.get("changed") is not False and moved["rev"] == rev + 1


def test_analytics_from_db(client):
    tok = register(client, email="e@a.test", org="Stats Co")["token"]
    c1 = _make_call(client, tok, ref="ROT-2026-0601", nrt=50000)
    client.post("/api/inspections", headers=auth(tok), json={
        "callId": c1, "cargoType": "Liquid", "product": "PMS", "reconciledTonnage": 45000,
        "jetty": {"type": "International", "category": None, "name": "J"}, "status": "completed"})
    c2 = _make_call(client, tok, ref="ROT-2026-0602", nrt=40000)
    client.post("/api/inspections", headers=auth(tok), json={
        "callId": c2, "cargoType": "Dry", "reconciledTonnage": 38000, "status": "completed"})
    a = client.get("/api/analytics?months=12", headers=auth(tok)).json()
    assert a["totals"]["throughput"] > 0
    assert a["totals"]["invoiced"] > 0
    assert any(p["key"] == "PMS" for p in a["products"])
    assert len(a["series"]) == 12


def test_last_admin_protected(client):
    reg = register(client, email="f@adm.test", org="Admin Co")
    tok = reg["token"]
    admin_id = reg["user"]["id"]
    r = client.put(f"/api/organization/members/{admin_id}", headers=auth(tok), json={"role": "Viewer"})
    assert r.status_code == 409     # cannot demote the last admin


def test_user_management_lifecycle(client):
    reg = register(client, email="g@users.test", org="Users Co")
    tok = reg["token"]

    created = client.post("/api/organization/members", headers=auth(tok), json={
        "name": "  Finance User  ", "email": "FINANCE@USERS.TEST",
        "password": "temporary-pass", "role": "Finance",
    })
    assert created.status_code == 201, created.text
    member = created.json()["member"]
    assert member["name"] == "Finance User"
    assert member["email"] == "finance@users.test"
    assert member["active"] is True
    assert member["createdAt"]

    invalid_role = client.put(
        f"/api/organization/members/{member['id']}",
        headers=auth(tok),
        json={"role": "Superuser"},
    )
    assert invalid_role.status_code == 422

    updated = client.put(
        f"/api/organization/members/{member['id']}",
        headers=auth(tok),
        json={"name": "Accounts Lead", "role": "Viewer", "password": "replacement-pass"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["member"]["name"] == "Accounts Lead"
    assert updated.json()["member"]["role"] == "Viewer"
    assert client.post("/api/auth/login", json={
        "email": member["email"], "password": "temporary-pass",
    }).status_code == 401
    assert client.post("/api/auth/login", json={
        "email": member["email"], "password": "replacement-pass",
    }).status_code == 200

    deactivated = client.put(
        f"/api/organization/members/{member['id']}",
        headers=auth(tok),
        json={"active": False},
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["member"]["active"] is False
    assert client.post("/api/auth/login", json={
        "email": member["email"], "password": "replacement-pass",
    }).status_code == 401

    reactivated = client.put(
        f"/api/organization/members/{member['id']}",
        headers=auth(tok),
        json={"active": True},
    )
    assert reactivated.status_code == 200
    assert client.delete(
        f"/api/organization/members/{member['id']}",
        headers=auth(tok),
    ).status_code == 200
    assert client.post("/api/auth/login", json={
        "email": member["email"], "password": "replacement-pass",
    }).status_code == 401


def test_user_management_is_admin_only_and_tenant_scoped(client):
    first = register(client, email="h@scope.test", org="Scope One")
    second = register(client, email="i@scope.test", org="Scope Two")
    second_member = client.post(
        "/api/organization/members",
        headers=auth(second["token"]),
        json={
            "name": "Second Org User", "email": "member@scope-two.test",
            "password": "member-password", "role": "Viewer",
        },
    ).json()["member"]

    cross_org = client.put(
        f"/api/organization/members/{second_member['id']}",
        headers=auth(first["token"]),
        json={"active": False},
    )
    assert cross_org.status_code == 404

    viewer_token = client.post("/api/auth/login", json={
        "email": second_member["email"], "password": "member-password",
    }).json()["token"]
    viewer_state = client.get("/api/state", headers=auth(viewer_token))
    assert viewer_state.status_code == 200
    assert viewer_state.json()["org"]["members"] == []
    assert client.post(
        "/api/organization/members",
        headers=auth(viewer_token),
        json={
            "name": "Not Allowed", "email": "no@scope-two.test",
            "password": "not-allowed-pass", "role": "Viewer",
        },
    ).status_code == 403


def test_admin_cannot_change_or_delete_own_access(client):
    reg = register(client, email="j@self.test", org="Self Protect Co")
    tok = reg["token"]
    admin_id = reg["user"]["id"]
    second_admin = client.post("/api/organization/members", headers=auth(tok), json={
        "name": "Backup Admin", "email": "backup@self.test",
        "password": "backup-password", "role": "Admin",
    })
    assert second_admin.status_code == 201

    assert client.put(
        f"/api/organization/members/{admin_id}",
        headers=auth(tok),
        json={"role": "Viewer"},
    ).status_code == 409
    assert client.put(
        f"/api/organization/members/{admin_id}",
        headers=auth(tok),
        json={"active": False},
    ).status_code == 409
    assert client.delete(
        f"/api/organization/members/{admin_id}",
        headers=auth(tok),
    ).status_code == 409

    backup_id = second_admin.json()["member"]["id"]
    assert client.put(
        f"/api/organization/members/{backup_id}",
        headers=auth(tok),
        json={"active": False},
    ).status_code == 200
    assert client.delete(
        f"/api/organization/members/{backup_id}",
        headers=auth(tok),
    ).status_code == 200
