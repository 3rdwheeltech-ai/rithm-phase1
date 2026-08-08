import {
  Blend,
  Disc3,
  Gauge,
  Image,
  Mic2,
  Music4,
  PenLine,
  Repeat2,
  Scissors,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The AI Tools shelf.
 *
 * None of these are built. They are here to say what RITHM is for beyond one
 * prompt box, and every card opens <ComingSoonDialog> rather than sitting
 * disabled — a greyed-out grid reads as broken software, not as a roadmap.
 *
 * The reference design carried sheet-music tools (PDF to MusicXML, Vocal to
 * MIDI). They are dropped: nothing in this product reaches notation, and
 * advertising a direction we are not walking is a promise, not a preview.
 *
 * Ten, because the grid is five wide and an orphaned row of two reads as an
 * accident. Adding an eleventh means finding a twelfth.
 */

export interface AiTool {
  name: string;
  description: string;
  Icon: LucideIcon;
}

export const AI_TOOLS: AiTool[] = [
  {
    name: "Stem Splitter",
    description: "Split a track into vocals, drums, bass and more",
    Icon: Scissors,
  },
  {
    name: "Extend Track",
    description: "Grow a finished track into a longer arrangement",
    Icon: Repeat2,
  },
  {
    name: "Remix",
    description: "Re-imagine one of your tracks in a new style",
    Icon: Disc3,
  },
  {
    name: "Cover Art",
    description: "Generate album artwork from the same prompt",
    Icon: Image,
  },
  {
    name: "Lyrics Assist",
    description: "Draft, rewrite and tighten your words",
    Icon: PenLine,
  },
  {
    name: "Voice Cloning",
    description: "Train a reusable AI voice of your own",
    Icon: Mic2,
  },
  {
    name: "Voice Designer",
    description: "Design a new voice by blending others",
    Icon: Blend,
  },
  {
    name: "AI Choir",
    description: "Generate layered chorals from your lyrics",
    Icon: Users,
  },
  {
    name: "AI Instrument",
    description: "Generate realistic instrument takes",
    Icon: Music4,
  },
  {
    name: "Analyse",
    description: "Read the tempo, key and scale of a track",
    Icon: Gauge,
  },
];
