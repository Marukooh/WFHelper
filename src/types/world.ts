export interface CycleData {
  activation?: string;
  expiry?: string;
  timeLeft?: string;
  isDay?: boolean;
  isWarm?: boolean;
  active?: string;
  [key: string]: unknown;
}

export interface Fissure {
  expired?: boolean;
  expiry?: string;
  tier?: string;
  isHard?: boolean;
  isStorm?: boolean;
  missionType?: string;
  node?: string;
  [key: string]: unknown;
}

export interface VaultTraderInventoryItem {
  uniqueName?: string;
  item?: string;
  ducats?: number;
  credits?: number;
  [key: string]: unknown;
}

export interface VaultTrader {
  activation?: string;
  expiry?: string;
  location?: string;
  inventory?: VaultTraderInventoryItem[];
  [key: string]: unknown;
}

interface DuviriChoiceSet {
  category: string;
  choices: string[];
  [key: string]: unknown;
}

interface DuviriCycle {
  state?: string;
  expiry?: string;
  choices?: DuviriChoiceSet[];
  [key: string]: unknown;
}

interface InvasionReward {
  items: string[];
  countedItems: { count: number; type: string }[];
  credits: number;
}

export interface Invasion {
  id: string;
  node: string;
  desc?: string;
  attacker: { reward?: InvasionReward; faction: string };
  defender: { reward?: InvasionReward; faction: string };
  vsInfestation: boolean;
  completion: number;
  completed: boolean;
}

interface BountyJob {
  type: string;
  enemyLevels: [number, number];
  /** Seed bounties only: 0-based tier; reward pools match by index, not level */
  tierIndex?: number;
  standingStages: number[];
  minMR?: number;
  challengeDesc?: string;
}

export interface SyndicateBounty {
  syndicate: string;
  syndicateKey: string;
  expiry?: string;
  jobs: BountyJob[];
}

interface SteelPathReward {
  name: string;
  cost: number;
}

export interface SteelPathHonors {
  currentReward: SteelPathReward;
  activation?: string;
  expiry?: string;
  rotation: SteelPathReward[];
  upcoming?: Array<
    SteelPathReward & {
      activation: string;
      expiry: string;
      weekOffset: number;
    }
  >;
  evergreens: SteelPathReward[];
}

interface SortieMission {
  node: string;
  mission: string;
  modifier: string;
}

export interface Sortie {
  activation?: string | null;
  expiry?: string | null;
  boss?: string;
  missions?: SortieMission[];
}

interface ArchonHuntMission {
  node: string;
  mission: string;
}

export interface ArchonHunt {
  activation: string | null;
  expiry: string | null;
  boss: string;
  missions: ArchonHuntMission[];
}

export interface NightwaveChallenge {
  id: string;
  title: string;
  /** Falls back to the title for the few acts DE ships without a description. */
  description: string;
  standing: number;
  requiredCount: number;
  isDaily: boolean;
  isElite: boolean;
  activation: string | null;
  expiry: string | null;
}

interface Nightwave {
  activation: string | null;
  expiry: string | null;
  season: number;
  phase: number;
  challenges: NightwaveChallenge[];
}

interface AlertReward {
  name: string;
  count: number;
}

export interface WorldAlert {
  id: string;
  activation: string | null;
  expiry: string | null;
  node: string;
  mission: string;
  faction: string;
  minLevel: number;
  maxLevel: number;
  credits: number;
  items: AlertReward[];
}

interface DailyDeal {
  uniqueName?: string;
  item?: string;
  imageOverride?: string | null;
  discount?: number;
  originalPrice?: number;
  salePrice?: number;
  total?: number;
  sold?: number;
  expiry?: string | null;
}

export interface WorldState {
  vaultTrader?: VaultTrader | null;
  voidTrader?: VaultTrader | null;
  dailyDeals?: DailyDeal[];
  earthCycle?: CycleData;
  cetusCycle?: CycleData;
  vallisCycle?: CycleData;
  cambionCycle?: CycleData;
  duviriCycle?: DuviriCycle;
  sortie?: Sortie | null;
  archonHunt?: ArchonHunt | null;
  nightwave?: Nightwave | null;
  alerts?: WorldAlert[];
  steelPath?: SteelPathHonors | null;
  fissures?: Fissure[];
  invasions?: Invasion[];
  bounties?: SyndicateBounty[];
  bountyRotation?: string;
  [key: string]: unknown;
}
