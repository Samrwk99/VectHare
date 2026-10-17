/**
 * Conversation Turns: collapse consecutive messages by role into logical turns,
 * then pair neighbouring runs in the chosen direction. Never reorder, merge
 * identities, discard or duplicate source messages.
 *
 * A leading run of the opposite role is attached to the first preferred pair
 * (or kept together with the only remaining run), so an opening greeting is
 * not silently orphaned from the dialogue it introduces.
 */
export const DEFAULT_TURN_ORDER = 'user_character';
export const TURN_ORDERS = Object.freeze(['user_character', 'character_user']);

export function normalizeTurnOrder(order) {
    return TURN_ORDERS.includes(order) ? order : DEFAULT_TURN_ORDER;
}

export function groupConversationTurns(messages, order = DEFAULT_TURN_ORDER) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const runs = [];
    for (const message of messages) {
        const isUser = !!message.is_user;
        const previous = runs[runs.length - 1];
        if (previous && previous.isUser === isUser) previous.messages.push(message);
        else runs.push({isUser, messages: [message]});
    }
    const preferredFirstIsUser = normalizeTurnOrder(order) === 'user_character';
    const groups = [];
    let index = 0;
    let leading = [];
    if (runs[0].isUser !== preferredFirstIsUser) {
        leading = runs[0].messages;
        index = 1;
    }
    while (index < runs.length) {
        const first = runs[index];
        // Runs alternate roles, so a preferred start is followed by its partner
        // unless it is the final, as-yet-unanswered turn.
        const second = runs[index + 1];
        const group = [...leading, ...first.messages];
        if (second) group.push(...second.messages);
        groups.push(group);
        leading = [];
        index += second ? 2 : 1;
    }
    if (leading.length) {
        if (groups.length) groups[groups.length - 1].unshift(...leading);
        else groups.push(leading);
    }
    return groups;
}
