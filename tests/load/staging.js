import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = __ENV.BASE_URL;
const sessionCookie = __ENV.LOAD_TEST_COOKIE;
const expectedRelease = __ENV.EXPECTED_RELEASE;

if (!baseUrl || !sessionCookie || !expectedRelease) {
  throw new Error("BASE_URL, LOAD_TEST_COOKIE, and EXPECTED_RELEASE are required");
}

export const options = {
  scenarios: {
    normal_api: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    "http_req_duration{endpoint:normal}": ["p(95)<500", "p(99)<1500"],
    "http_req_failed{endpoint:normal}": ["rate<0.01"],
  },
};

const headers = {
  Cookie: sessionCookie,
  Accept: "application/json",
};

export default function () {
  const releaseResponse = http.get(`${baseUrl}/api/health`, {
    headers,
    tags: { endpoint: "release_identity" },
  });
  let deployedRelease = "";
  try {
    deployedRelease = releaseResponse.json("release.tag");
  } catch (_error) {
    deployedRelease = "";
  }
  const releaseMatches = check(releaseResponse, {
    "deployed release matches requested artifact": (response) =>
      response.status === 200 && deployedRelease === expectedRelease,
  });
  if (!releaseMatches) {
    throw new Error(`Expected ${expectedRelease}, received ${deployedRelease || "no release identity"}`);
  }

  const responses = http.batch([
    ["GET", `${baseUrl}/api/health`, null, { headers, tags: { endpoint: "health" } }],
    ["GET", `${baseUrl}/api/auth/me`, null, { headers, tags: { endpoint: "normal" } }],
    ["GET", `${baseUrl}/api/state`, null, { headers, tags: { endpoint: "normal" } }],
    ["GET", `${baseUrl}/api/vessel-calls?page=1&pageSize=25`, null, { headers, tags: { endpoint: "normal" } }],
    ["GET", `${baseUrl}/api/invoices?page=1&pageSize=25`, null, { headers, tags: { endpoint: "normal" } }],
  ]);

  check(responses, {
    "all requests succeeded": (batch) => batch.every((response) => response.status >= 200 && response.status < 300),
  });
  sleep(1);
}
