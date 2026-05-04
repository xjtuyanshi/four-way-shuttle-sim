import type { LayoutCalibrationProfile } from '@four-way-shuttle/schemas';

export type ShuttleLayoutGeometryProfile = {
  calibrationProfile: LayoutCalibrationProfile;
  storageRowsPerBank: number;
  storageRowBanks: 2;
  storageColumnsPerBay: number;
  storageColumnBays: number;
  storageCellPitchXM: number;
  storageCellPitchZM: number;
  leftSpineXM: number;
  firstStorageXM: number;
  storageBayGapXM: number;
  storageInnerRowZM: number;
  sideClearanceXM: number;
  mainLaneNorthZM: number;
  mainLaneSouthZM: number;
  liftStandoffZM: number;
  parkingStandoffXM: number;
};

export type ShuttleLayoutCalibrationProfileOverride = Partial<LayoutCalibrationProfile>;

export type ShuttleLayoutGeometryProfileOverride = Partial<Omit<ShuttleLayoutGeometryProfile, 'calibrationProfile'>> & {
  calibrationProfile?: ShuttleLayoutCalibrationProfileOverride;
};

export const DEFAULT_SHUTTLE_LAYOUT_PROFILE: ShuttleLayoutGeometryProfile = {
  calibrationProfile: {
    id: 'phase0-cad-assumption-v1',
    label: 'Phase 0 real-layout assumption profile',
    status: 'assumption',
    units: 'meter',
    sourceDescription: 'User CAD screenshot IMG_8078 plus public four-way pallet-shuttle references; dimensions are placeholders until CAD/vendor/site values are confirmed.',
    dimensions: [
      {
        key: 'storageCellPitchX',
        label: 'Storage cell pitch X',
        valueM: 1.25,
        source: 'assumed',
        confidence: 'low',
        note: 'Placeholder for pallet position pitch along a FIFO storage row.'
      },
      {
        key: 'storageCellPitchZ',
        label: 'Storage row pitch Z',
        valueM: 1.2,
        source: 'assumed',
        confidence: 'low',
        note: 'Placeholder for adjacent row center spacing inside a dense storage bank.'
      },
      {
        key: 'storageBayGapX',
        label: 'Vertical aisle gap between storage islands',
        valueM: 2.25,
        source: 'assumed',
        confidence: 'low',
        note: 'Represents the yellow vertical shuttle corridors between column islands.'
      },
      {
        key: 'mainLaneCenterSpacingZ',
        label: 'Two-lane main corridor center spacing',
        valueM: 1.6,
        source: 'assumed',
        confidence: 'low',
        note: 'Modeled as two adjacent one-capacity lanes, not as one capacity-2 lane.'
      },
      {
        key: 'innerStorageBankGapZ',
        label: 'Gap between upper/lower storage banks',
        valueM: 4.4,
        source: 'assumed',
        confidence: 'low',
        note: 'Approximate visible CAD label pending confirmation from a clean top-down drawing.'
      },
      {
        key: 'liftStandoffZ',
        label: 'Lift/transfer station standoff from outer aisle',
        valueM: 1.8,
        source: 'assumed',
        confidence: 'low'
      },
      {
        key: 'sideClearanceX',
        label: 'Side spine clearance from storage block',
        valueM: 2.5,
        source: 'assumed',
        confidence: 'low'
      }
    ],
    notes: [
      'Single-floor simulation only; lifts are dedicated inbound/outbound black-box ports.',
      'Storage cells are contiguous drivable track positions inside each island, not freestanding boxes.',
      'All vehicle movement remains orthogonal; no diagonal shortcut edges are generated.',
      'Blocked structural cells from the CAD screenshot are not encoded until exact CAD metadata is available.'
    ]
  },
  storageRowsPerBank: 8,
  storageRowBanks: 2,
  storageColumnsPerBay: 6,
  storageColumnBays: 4,
  storageCellPitchXM: 1.25,
  storageCellPitchZM: 1.2,
  leftSpineXM: 0,
  firstStorageXM: 2.5,
  storageBayGapXM: 2.25,
  storageInnerRowZM: 2.2,
  sideClearanceXM: 2.5,
  mainLaneNorthZM: -0.8,
  mainLaneSouthZM: 0.8,
  liftStandoffZM: 1.8,
  parkingStandoffXM: 2.4
};

function roundProfileValue(value: number): number {
  return Number(value.toFixed(6));
}

function calibrationDimensionValues(profile: ShuttleLayoutGeometryProfile): Record<string, number> {
  return {
    storageCellPitchX: roundProfileValue(profile.storageCellPitchXM),
    storageCellPitchZ: roundProfileValue(profile.storageCellPitchZM),
    storageBayGapX: roundProfileValue(profile.storageBayGapXM),
    mainLaneCenterSpacingZ: roundProfileValue(Math.abs(profile.mainLaneSouthZM - profile.mainLaneNorthZM)),
    innerStorageBankGapZ: roundProfileValue(profile.storageInnerRowZM * 2),
    liftStandoffZ: roundProfileValue(profile.liftStandoffZM),
    sideClearanceX: roundProfileValue(profile.sideClearanceXM)
  };
}

function syncedCalibrationDimensions(
  profile: ShuttleLayoutGeometryProfile,
  dimensions: LayoutCalibrationProfile['dimensions']
): LayoutCalibrationProfile['dimensions'] {
  const valuesByKey = calibrationDimensionValues(profile);
  return dimensions.map((dimension) => ({
    ...dimension,
    valueM: valuesByKey[dimension.key] ?? dimension.valueM
  }));
}

export function createShuttleLayoutProfile(overrides: ShuttleLayoutGeometryProfileOverride = {}): ShuttleLayoutGeometryProfile {
  const { calibrationProfile: calibrationProfileOverrides, ...geometryOverrides } = overrides;
  const geometryProfile: ShuttleLayoutGeometryProfile = {
    ...DEFAULT_SHUTTLE_LAYOUT_PROFILE,
    ...geometryOverrides,
    calibrationProfile: DEFAULT_SHUTTLE_LAYOUT_PROFILE.calibrationProfile
  };
  const calibrationProfile = {
    ...DEFAULT_SHUTTLE_LAYOUT_PROFILE.calibrationProfile,
    ...calibrationProfileOverrides,
    dimensions: calibrationProfileOverrides?.dimensions ?? syncedCalibrationDimensions(
      geometryProfile,
      DEFAULT_SHUTTLE_LAYOUT_PROFILE.calibrationProfile.dimensions
    ),
    notes: calibrationProfileOverrides?.notes ?? DEFAULT_SHUTTLE_LAYOUT_PROFILE.calibrationProfile.notes
  };
  const profile = {
    ...geometryProfile,
    calibrationProfile
  };
  if (profile.storageRowBanks !== 2) {
    throw new Error('Phase 0 layout generation supports exactly two storage row banks.');
  }
  return profile;
}
