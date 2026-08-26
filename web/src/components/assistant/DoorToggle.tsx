import { MessageSquare, Mic } from "lucide-react";
import Segmented from "../create/Segmented";
import { useAssistant, type AssistantMode } from "../../store/assistant";

/**
 * Talk / Chat, the way Create says Simple / Advanced.
 *
 * THE WAY BACK. Chat used to be a one-way door: opening it replaced the avatar
 * outright, and the only route home was an X that read as "close the panel"
 * rather than "go back to voice". A segmented control says what the other side
 * is, and says it from inside the conversation.
 *
 * IT MUST SIT IN THE SAME PLACE IN BOTH PANELS — directly under the header row
 * in `AvatarPanel` and in `ChatPanel` — because switching swaps the whole
 * panel underneath it. A control that moves when you press it makes going back
 * a second act of aim.
 *
 * `Segmented` is `.lg-regular`, not `.lg-lens`: the lens budget is spent (four
 * on screen at once is the ceiling, and Home spends all four), and this renders
 * inside one of them.
 */
export default function DoorToggle({ className = "" }: { className?: string }) {
  const mode = useAssistant((s) => s.mode);
  const setMode = useAssistant((s) => s.setMode);

  return (
    <div className={className}>
      <Segmented<AssistantMode>
        ariaLabel="Assistant mode"
        size="sm"
        value={mode}
        onChange={setMode}
        options={[
          { value: "talk", label: "Talk", icon: Mic },
          { value: "chat", label: "Chat", icon: MessageSquare },
        ]}
      />
    </div>
  );
}
