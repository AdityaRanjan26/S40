"""
AVARAN Adaptive Defense Copilot (Columbo Protocol v2).

Dynamically generates targeted adversarial challenges and verification prompts
based on the live threat matrix:
- Synthetic/cloned voice detected -> Voice Liveness / Phonetic Challenge
- Digital arrest / Authority fraud -> Phantom Badge & Administrative Dead-End Inquiries
"""

from typing import Dict, Any, List, Optional
from engine.copilot.static_trap_prompts import get_trap_prompt, TRAP_PROMPTS


class AdaptiveCopilot:
    """
    Adaptive counter-inquiry copilot that prescribes context-sensitive challenges
    to dismantle social engineering dominance during live suspicious calls.
    """

    CHALLENGES: Dict[str, Dict[str, str]] = {
        "VOICE_LIVENESS_CHALLENGE": {
            "en": "Voice anomaly detected: Please ask the caller to state today's date and the word 'AVARAN' aloud.",
            "hi": "आवाज़ में गड़बड़ी: कॉलर से आज की तारीख और 'अवारन' शब्द बोलने को कहें।",
            "bn": "কণ্ঠস্বরে অস্বাভাবিকতা: কলারকে আজকের তারিখ এবং 'আভরণ' শব্দটি উচ্চারণ করতে বলুন।",
        },
    }

    def evaluate_response_strategy(
        self,
        risk_score: int,
        scam_categories: List[str] = None,
        is_synthetic_voice: bool = False,
        language: str = "en",
    ) -> Dict[str, Any]:
        """
        Synthesizes active threat signals into prioritized counter-inquiry guidance.

        Returns:
            Dict containing:
                - recommended_challenge: str
                - escalation_action: str ('NONE', 'PROMPT_CHALLENGE', 'TERMINATE_CALL')
                - explanation: str
        """
        categories = scam_categories or []
        lang = language if language in ("en", "hi", "bn") else "en"

        # 1. Synthetic voice liveness priority
        if is_synthetic_voice:
            return {
                "recommended_challenge": self.CHALLENGES["VOICE_LIVENESS_CHALLENGE"][lang],
                "challenge_type": "VOICE_LIVENESS",
                "escalation_action": "PROMPT_CHALLENGE",
                "explanation": "Synthetic or cloned audio stream detected.",
            }

        # 2. Linguistic scam intent traps (Columbo Protocol)
        if categories:
            trap = get_trap_prompt(categories[0], language=lang)
            if trap:
                return {
                    "recommended_challenge": trap,
                    "challenge_type": "ADMINISTRATIVE_DEADEND",
                    "escalation_action": "PROMPT_CHALLENGE" if risk_score < 75 else "TERMINATE_CALL",
                    "explanation": f"Active social engineering pattern ({categories[0]}) detected.",
                }

        return {
            "recommended_challenge": "",
            "challenge_type": "NONE",
            "escalation_action": "NONE",
            "explanation": "Call characteristics within normal parameters.",
        }
