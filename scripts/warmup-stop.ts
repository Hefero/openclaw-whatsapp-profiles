import {
  printStatuses,
  stopManaged,
  type ManagedName
} from './warmup-utils.js';

const names: ManagedName[] = [
  'openclaw-worker',
  'openclaw-control',
  'openclaw-gateway',
  'codex-proxy'
];

printStatuses(names.map(stopManaged));
