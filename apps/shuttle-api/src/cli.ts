import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultShuttleScenario } from '@four-way-shuttle/sim-core';

import { collectPrerequisites } from './prerequisites.js';
import { validatePhase0Scenario } from './validation.js';

const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

const report = {
  prerequisites: await collectPrerequisites(),
  validation: validatePhase0Scenario(createDefaultShuttleScenario(), {
    durationSec: 240,
    repeatCount: 3
  })
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await writeFile(outputPath, serialized, 'utf8');
  console.log(`Wrote Phase 0 validation report to ${outputPath}`);
} else {
  console.log(serialized);
}
