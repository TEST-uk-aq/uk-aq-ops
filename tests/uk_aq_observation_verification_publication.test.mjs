import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  buildObservationVerificationRefreshInputs,
  verificationPeriodsFromRatifiedTo,
} from "../workers/shared/uk_aq_observation_verification_overlay.mjs";
import {
  buildObservationVerificationConnectorPublication,
  buildObservationVerificationLatestPublication,
  publishObservationVerificationConnectorManifest,
  publishObservationVerificationLatest,
} from "../workers/shared/uk_aq_observation_verification_publication.mjs";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";

async function connectorPublication() {
  const manifest = buildObservationVerificationRefreshInputs({
    connectorId: 9,
    semanticSourceIdentity: {
      source_system: "official-network-rdata",
      connector_id: 9,
      verification_model: "ratification-boundary-v1",
    },
    timeseries: [{
      connector_id: 9,
      timeseries_id: 9001,
      station_id: 901,
      pollutant_code: "no2",
      ...verificationPeriodsFromRatifiedTo("2026-06-30", {
        semanticSourceProvenance: {
          source_system: "official-network-rdata",
          network: "waqn",
          site_id: "SITE901",
          parameter: "NO2",
        },
      }),
    }],
    acquisitionEvidence: {},
  }).canonical_manifest;
  return buildObservationVerificationConnectorPublication({ manifest });
}

function missingHeadSizeR2(events) {
  const objects = new Map();
  return {
    adapter: {
      async putObject({ key, body }) {
        events.push(`put:${key}`);
        objects.set(key, Buffer.from(body));
        return { key };
      },
      async headObject({ key }) {
        events.push(`head:${key}`);
        const body = objects.get(key);
        return {
          exists: Boolean(body),
          key,
          bytes: null,
          sha256: body ? sha256Hex(body) : null,
          etag: "head-etag",
        };
      },
      async getObject({ key }) {
        events.push(`get:${key}`);
        const body = objects.get(key);
        return { key, bytes: body.byteLength, body, etag: "get-etag" };
      },
    },
  };
}

test("connector publication enables stored-body GET fallback when HEAD size is unavailable", async () => {
  const publication = await connectorPublication();
  const events = [];
  const durable = await publishObservationVerificationConnectorManifest({
    r2: missingHeadSizeR2(events),
    publication,
  });

  assert.deepEqual(events, [
    `put:${publication.artifact.key}`,
    `head:${publication.artifact.key}`,
    `get:${publication.artifact.key}`,
  ]);
  assert.equal(durable.connector_id, 9);
  assert.equal(durable.verified, true);
  assert.equal(durable.stored_byte_size_verified, true);
  assert.equal(durable.stored_sha256_verified, true);
  assert.equal(durable.stored_body_get_verified, true);
});

test("latest publication enables stored-body GET fallback when HEAD size is unavailable", async () => {
  const connector = await connectorPublication();
  const publication = await buildObservationVerificationLatestPublication({
    connectorManifestIdentities: [connector.latest_identity],
  });
  const events = [];
  const durable = await publishObservationVerificationLatest({
    r2: missingHeadSizeR2(events),
    publication,
    durableConnectorManifests: [{
      ...connector.latest_identity,
      verified: true,
    }],
  });

  assert.deepEqual(events, [
    `put:${publication.artifact.key}`,
    `head:${publication.artifact.key}`,
    `get:${publication.artifact.key}`,
  ]);
  assert.equal(durable.verified, true);
  assert.equal(durable.stored_byte_size_verified, true);
  assert.equal(durable.stored_sha256_verified, true);
  assert.equal(durable.stored_body_get_verified, true);
});

test("latest publication does not begin without durable connector verification", async () => {
  const connector = await connectorPublication();
  const publication = await buildObservationVerificationLatestPublication({
    connectorManifestIdentities: [connector.latest_identity],
  });
  let putCount = 0;

  await assert.rejects(
    publishObservationVerificationLatest({
      r2: {
        adapter: {
          async putObject() { putCount += 1; },
        },
      },
      publication,
      durableConnectorManifests: [{
        ...connector.latest_identity,
        verified: false,
      }],
    }),
    /unverified or mismatched connector manifest/,
  );
  assert.equal(putCount, 0);
});
