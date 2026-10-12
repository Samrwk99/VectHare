/**
 * Tests for collection metadata activation policies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: {},
}));

vi.mock('../core/../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import { extension_settings } from '../core/../../../../extensions.js';
import {
    setCollectionMeta,
    setCollectionLock,
    shouldCollectionActivate,
    addCollectionToChatPolicy,
    setChatCollectionPolicy,
    getChatCollectionPolicy,
    applyChatCollectionPolicy,
    filterActiveCollections,
} from '../core/collection-metadata.js';

describe('collection metadata activation policies', () => {
    beforeEach(() => {
        extension_settings.vecthare = { collections: {}, chatCollectionPolicies: {} };
    });

    it('should block exclusive chat-locked collections outside their locked chat', async () => {
        setCollectionMeta('lorebook_alpha', {
            enabled: true,
            alwaysActive: true,
            lockMode: 'exclusive',
        });
        setCollectionLock('lorebook_alpha', 'chat-2');

        await expect(shouldCollectionActivate('lorebook_alpha', {
            currentChatId: 'chat-1',
            collectionDecisions: [],
        })).resolves.toBe(false);

        await expect(shouldCollectionActivate('lorebook_alpha', {
            currentChatId: 'chat-2',
            collectionDecisions: [],
        })).resolves.toBe(true);
    });

    it('should force collections selected for the current chat without triggers', async () => {
        setCollectionMeta('lorebook_forced', {
            enabled: true,
            triggers: [],
            conditions: { enabled: false, rules: [] },
        });
        addCollectionToChatPolicy('chat-2', 'lorebook_forced');

        await expect(shouldCollectionActivate('lorebook_forced', {
            currentChatId: 'chat-2',
            collectionDecisions: [],
        })).resolves.toBe(true);
    });

    it('should keep disabled collections blocked even when selected for the chat', async () => {
        setCollectionMeta('lorebook_disabled_forced', { enabled: false });
        addCollectionToChatPolicy('chat-2', 'lorebook_disabled_forced');

        await expect(shouldCollectionActivate('lorebook_disabled_forced', {
            currentChatId: 'chat-2',
            collectionDecisions: [],
        })).resolves.toBe(false);
    });

    it('should apply only-selected chat policy to lorebook collections without removing non-lorebooks', () => {
        setChatCollectionPolicy('chat-2', {
            mode: 'only_selected',
            selectedCollections: ['lorebook_keep'],
        });

        const result = applyChatCollectionPolicy(
            ['lorebook_keep', 'lorebook_drop', 'vecthare_chat_current'],
            'chat-2',
            { lorebooksOnly: true }
        );

        expect(result).toEqual(['lorebook_keep', 'vecthare_chat_current']);
        expect(getChatCollectionPolicy('chat-2').mode).toBe('only_selected');
    });

    it('should suppress peer lorebooks when an exclusive lorebook is active', async () => {
        setCollectionMeta('lorebook_exclusive', {
            enabled: true,
            alwaysActive: true,
            exclusiveWhenActive: true,
            exclusiveScope: 'lorebook',
        });
        setCollectionMeta('lorebook_other', {
            enabled: true,
            alwaysActive: true,
        });
        setCollectionMeta('document_other', {
            enabled: true,
            alwaysActive: true,
        });

        const active = await filterActiveCollections(
            ['lorebook_exclusive', 'lorebook_other', 'document_other'],
            { currentChatId: 'chat-2', collectionDecisions: [] }
        );

        expect(active).toEqual(['lorebook_exclusive', 'document_other']);
    });
});
