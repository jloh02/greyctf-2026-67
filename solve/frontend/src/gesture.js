export const DEFAULT_GESTURE_CONFIG = {
  crossThreshold: 0.1,
  minCrossesPerFlap: 2,
  trackingGraceMs: 420,
  anchorSmoothing: 0.45,
  fastAnchorSmoothing: 0.72,
  fastMovementThreshold: 0.075,
  jumpDebounceMs: 300,
  levelResetMs: 360,
};

export const FAST_HAND_LANDMARKER_OPTIONS = {
  runningMode: "VIDEO",
  numHands: 2,
  minHandDetectionConfidence: 0.35,
  minHandPresenceConfidence: 0.35,
  minTrackingConfidence: 0.25,
};

export function orderedHands(result) {
  const landmarks = result.landmarks || [];
  const handsBySide = [null, null];

  for (const handLandmarks of landmarks) {
    const anchor = handAnchorPoint(handLandmarks);
    if (!anchor) {
      continue;
    }

    const side = screenSideIndex(anchor);
    const candidate = {
      landmarks: handLandmarks,
      anchor,
      distanceFromSideCenter: Math.abs(anchor.x - (side === 0 ? 0.75 : 0.25)),
    };
    const current = handsBySide[side];
    if (!current || candidate.distanceFromSideCenter < current.distanceFromSideCenter) {
      handsBySide[side] = candidate;
    }
  }

  return handsBySide.filter(Boolean).map((hand) => hand.landmarks);
}

export function screenSideIndex(anchor) {
  return anchor.x >= 0.5 ? 0 : 1;
}

export function handAnchorPoint(hand) {
  const landmarks = hand.filter(
    (landmark) => landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y),
  );
  if (!landmarks.length) {
    return null;
  }

  return {
    x: median(landmarks.map((landmark) => landmark.x)),
    y: median(landmarks.map((landmark) => landmark.y)),
    z: median(landmarks.map((landmark) => landmark.z || 0)),
  };
}

export function handHeight(anchor) {
  return 1 - anchor.y;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
