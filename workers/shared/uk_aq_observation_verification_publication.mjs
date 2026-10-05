// @ts-nocheck -- checksum-aware Node publication primitives; no caller publishes by default.
import { Buffer } from "node:buffer";

import { putAndVerifyR2ObjectWithSha256 } from "./uk_aq_r2_checksum_publication.mjs";
import {
  OBSERVATION_VERIFICATION_LATEST_KEY,
  buildObservationVerificationArtifact,
  buildObservationVerificationConnectorArtifact,
  buildObservationVerificationLatest,
  validateObservationVerificationConnectorManifest,
} from "./uk_aq_observation_verification_overlay.mjs";

function publicationIntent(artifact) {
  return Object.freeze({
    ...artifact,
    body: Buffer.from(artifact.body),
  });
}

export async function buildObservationVerificationConnectorPublication({ manifest }) {
  const canonicalManifest = validateObservationVerificationConnectorManifest(manifest);
  const artifact = await buildObservationVerificationConnectorArtifact(
    canonicalManifest,
  );
  return Object.freeze({
    artifact: publicationIntent(artifact),
    latest_identity: Object.freeze({
      connector_id: canonicalManifest.connector_id,
      key: artifact.key,
      byte_size: artifact.byte_size,
      sha256: artifact.sha256,
    }),
  });
}

export async function buildObservationVerificationLatestPublication({
  connectorManifestIdentities,
}) {
  const payload = buildObservationVerificationLatest({
    connectorManifests: connectorManifestIdentities,
  });
  return Object.freeze({
    payload,
    artifact: publicationIntent(await buildObservationVerificationArtifact({
      key: OBSERVATION_VERIFICATION_LATEST_KEY,
      payload,
    })),
  });
}

export async function publishObservationVerificationConnectorManifest({ r2, publication }) {
  const durable = await putAndVerifyR2ObjectWithSha256({
    r2,
    intent: publication.artifact,
    verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
  });
  return Object.freeze({
    connector_id: publication.latest_identity.connector_id,
    ...durable,
  });
}

export async function publishObservationVerificationLatest({
  r2,
  publication,
  durableConnectorManifests,
}) {
  const durableByKey = new Map((durableConnectorManifests || [])
    .filter((entry) => entry?.verified === true)
    .map((entry) => [entry.key, entry]));
  for (const expected of publication.payload.connectors) {
    const durable = durableByKey.get(expected.key);
    if (
      !durable || Number(durable.connector_id) !== expected.connector_id ||
      Number(durable.byte_size) !== expected.byte_size ||
      durable.sha256 !== expected.sha256
    ) {
      throw new Error(
        `verification latest references an unverified or mismatched connector manifest: ${expected.key}`,
      );
    }
  }
  return putAndVerifyR2ObjectWithSha256({
    r2,
    intent: publication.artifact,
    verifyStoredBodyWithGetWhenHeadSizeUnavailable: true,
  });
}
