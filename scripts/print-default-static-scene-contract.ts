import {
  createDefaultShuttleScenario,
  summarizeScenarioStaticSceneContract
} from '../packages/shuttle-sim-core/src/index.js';

console.log(JSON.stringify(summarizeScenarioStaticSceneContract(createDefaultShuttleScenario()), null, 2));
