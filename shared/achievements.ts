export interface AchievementDef {
  id: string;
  name: string;
  emoji: string;
  desc: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_tool', name: 'First Tool', emoji: '🔨', desc: 'Invent your first item' },
  { id: 'inventor', name: 'Inventor', emoji: '💡', desc: 'Invent 5 different things' },
  { id: 'failure', name: 'Trial and Error', emoji: '💥', desc: 'Fail 3 invention attempts' },
  { id: 'homeowner', name: 'Homeowner', emoji: '🏠', desc: 'Build yourself a home' },
  { id: 'explorer', name: 'Explorer', emoji: '🗺️', desc: 'Explore 40% of the island' },
  { id: 'aviator', name: 'First Flight', emoji: '🕊️', desc: 'Take to the air' },
  { id: 'scholar', name: 'Sage', emoji: '🎓', desc: 'Reach tech level 4' },
  { id: 'teacher', name: 'Teacher', emoji: '📚', desc: 'Teach someone a recipe' },
  { id: 'student', name: 'Apprentice', emoji: '👀', desc: 'Learn a recipe from someone else' },
  { id: 'trader', name: 'Trader', emoji: '🤝', desc: 'Make 3 trades' },
  { id: 'generous', name: 'Generous', emoji: '🎁', desc: 'Give someone a gift' },
  { id: 'chatterbox', name: 'Chatterbox', emoji: '💬', desc: 'Have 10 conversations' },
  { id: 'best_friend', name: 'Best Friends', emoji: '💞', desc: 'Become close friends with someone' },
  { id: 'ally', name: 'Ally', emoji: '🛡️', desc: 'Form an alliance' },
  { id: 'first_fight', name: 'First Fight', emoji: '⚔️', desc: 'Start a fight' },
  { id: 'victor', name: 'Victor', emoji: '🏆', desc: 'Knock someone out in a fight' },
  { id: 'peacemaker', name: 'Peacemaker', emoji: '☮️', desc: 'Make peace with a rival' },
  { id: 'survivor', name: 'Survivor', emoji: '💪', desc: 'Recover after fainting' },
  { id: 'pacifist', name: 'Pacifist', emoji: '🌿', desc: '5 friendly chats and no fights for 3 days' },
  { id: 'parent', name: 'Parent', emoji: '🥚', desc: 'Start a family' },
  { id: 'golem_maker', name: 'Lifegiver', emoji: '🤖', desc: 'Create a golem' },
  { id: 'healer', name: 'Healer', emoji: '❤️‍🩹', desc: 'Heal with a potion' },
  { id: 'merchant', name: 'Market Trader', emoji: '🏪', desc: 'Make 5 market trades' },
  { id: 'landlord', name: 'Landlord', emoji: '🚩', desc: 'Plant a flag and claim land' },
  { id: 'warlord', name: 'Warlord', emoji: '🗡️', desc: 'Declare war' },
  { id: 'raider', name: 'Wrecker', emoji: '💥', desc: 'Raze a structure' },
  { id: 'driver', name: 'Driver', emoji: '🚗', desc: 'Go for a ride in your vehicle' },
  { id: 'tycoon', name: 'Berry Baron', emoji: '💰', desc: 'Own 30 berries' },
];

export interface AchievementUnlock {
  achievementId: string;
  agentId: string;
  agentName: string;
  day: number;
  timeOfDay: number;
  firstInWorld: boolean;
}
