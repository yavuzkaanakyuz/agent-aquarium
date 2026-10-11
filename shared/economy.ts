/** Berry economy: berries are both food and money. Materials are bought and sold for berries at the market. */
export const TRADE_ITEMS = ['wood', 'stone', 'fiber'] as const;
export type TradeItem = (typeof TRADE_ITEMS)[number];

export interface MarketOrder {
  id: number;
  agentId: string;
  agentName: string;
  side: 'sell' | 'buy';
  item: TradeItem;
  qty: number;
  price: number; // berries per unit
  day: number;
}

export interface MarketTrade {
  tick: number;
  day: number;
  timeOfDay: number;
  item: TradeItem;
  qty: number;
  price: number;
  buyer: string;
  seller: string;
}

export interface PriceInfo {
  last: number | null;
  bid: number | null; // highest bid
  ask: number | null; // lowest ask
  volume: number; // units traded today
  history: { tick: number; price: number }[];
}

export interface EconomyStats {
  day: number;
  berries: { inventories: number; bushes: number; market: number; total: number };
  /** Today's flows */
  flows: { harvested: number; eaten: number; airdropped: number; burned: number; spoiled: number };
  /** Recent days' supply/flow history (per day) */
  daily: { day: number; supply: number; harvested: number; eaten: number }[];
  prices: Record<TradeItem, PriceInfo>;
  wealth: { id: string; name: string; color: string; berries: number; materials: number; netWorth: number }[];
  gini: number;
  orders: MarketOrder[];
  recentTrades: MarketTrade[];
  settings: { scarcity: number; spoilage: number; fee: number };
  marketId: number | null;
}
