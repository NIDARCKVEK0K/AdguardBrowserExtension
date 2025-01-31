/**
 * @file
 * This file is part of AdGuard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * AdGuard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard Browser Extension. If not, see <http://www.gnu.org/licenses/>.
 */
import {
    AddAndEnableFilterMessage,
    DisableFilterMessage,
    DisableFiltersGroupMessage,
    EnableFiltersGroupMessage,
    MessageType,
} from '../../common/messages';
import { Log } from '../../common/log';
import { SettingOption } from '../schema';
import { messageHandler } from '../message-handler';
import { Engine } from '../engine';
import {
    FilterMetadata,
    FiltersApi,
    FilterUpdateApi,
    toasts,
    Categories,
    PageStatsApi,
    HitStatsApi,
} from '../api';
import {
    ContextMenuAction,
    contextMenuEvents,
    settingsEvents,
} from '../events';
import { listeners } from '../notifier';

/**
 * FiltersService creates handlers for messages that relate to filters.
 */
export class FiltersService {
    /**
     * Adds a listener for background messages about working with filters:
     * disabling, enabling, adding, removing.
     * Adds a listener for updating filters from the context menu.
     * Adds a listener for changing the settings of optimized filters and
     * disabling hit collection.
     */
    public static async init(): Promise<void> {
        messageHandler.addListener(MessageType.AddAndEnableFilter, FiltersService.onFilterEnable);
        messageHandler.addListener(MessageType.DisableFilter, FiltersService.onFilterDisable);
        messageHandler.addListener(MessageType.EnableFiltersGroup, FiltersService.onGroupEnable);
        messageHandler.addListener(MessageType.DisableFiltersGroup, FiltersService.onGroupDisable);
        messageHandler.addListener(MessageType.CheckFiltersUpdate, FiltersService.manualCheckFiltersUpdate);
        messageHandler.addListener(MessageType.ResetBlockedAdsCount, FiltersService.resetBlockedAdsCount);

        contextMenuEvents.addListener(ContextMenuAction.UpdateFilters, FiltersService.manualCheckFiltersUpdate);

        settingsEvents.addListener(SettingOption.UseOptimizedFilters, FiltersService.onOptimizedFiltersSwitch);
        settingsEvents.addListener(SettingOption.DisableCollectHits, FiltersService.onCollectHitsSwitch);
    }

    /**
     * Enables filter on {@link AddAndEnableFilterMessage} message via {@link FiltersService.enableFilter}.
     * If filter group has not been touched before, it will be activated.
     *
     * NOTE: we do not await of async task execution and returns group id optimistic.
     * TODO (v.zhelvis): handle enabling of group on frontend instead using this handler,
     * because this is UI edge case.
     *
     * @param message Message of {@link AddAndEnableFilterMessage} with filter
     * id to enable.
     *
     * @returns Id of the enabled filter group, if it has not been touched before, otherwise returns undefined.
     */
    private static onFilterEnable(message: AddAndEnableFilterMessage): number | undefined {
        const { filterId } = message.data;

        FiltersService.enableFilter(filterId);

        const group = Categories.getGroupByFilterId(filterId);

        if (!group) {
            return;
        }

        const { groupId } = group;

        const groupState = Categories.getGroupState(groupId);

        if (groupState && !groupState.touched) {
            return groupId;
        }
    }

    /**
     * Called at the request to disable filter.
     *
     * @param message Message of {@link DisableFilterMessage} with filter
     * id to disable.
     */
    private static async onFilterDisable(message: DisableFilterMessage): Promise<void> {
        const { filterId } = message.data;

        FiltersApi.disableFilters([filterId]);

        Engine.debounceUpdate();
    }

    /**
     * Enables group on {@link EnableFiltersGroupMessage} message via {@link FiltersService.enableGroup}.
     *
     * If group is activated first time, provides list of recommended filters.
     * NOTE: we do not await of async task execution and returns array of recommended filters optimistic.
     * TODO (v.zhelvis): handle enabling of recommended filters on frontend instead using this handler,
     * because this is UI edge case.
     *
     * @param message {@link EnableFiltersGroupMessage} With specified group id.
     *
     * @returns Array of recommended filters on first group activation.
     */
    private static onGroupEnable(message: EnableFiltersGroupMessage): number[] | undefined {
        const { groupId } = message.data;

        const group = Categories.getGroupState(groupId);

        if (!group) {
            Log.error(`Cannot find group with ${groupId} id`);
            return;
        }

        if (group.touched) {
            FiltersService.enableGroup(groupId);
            return;
        }

        // If this is the first time the group has been activated - load and
        // enable the recommended filters.
        const recommendedFiltersIds = Categories.getRecommendedFilterIdsByGroupId(groupId);
        FiltersService.enableGroup(groupId, recommendedFiltersIds);
        return recommendedFiltersIds;
    }

    /**
     * Called at the request to disable group of filters.
     *
     * @param message Message of {@link DisableFiltersGroupMessage} with group
     * id to disable.
     */
    private static async onGroupDisable(message: DisableFiltersGroupMessage): Promise<void> {
        const { groupId } = message.data;

        Categories.disableGroup(groupId);
        Engine.debounceUpdate();
    }

    /**
     * Called when requesting an force update for filters.
     */
    private static async manualCheckFiltersUpdate(): Promise<FilterMetadata[] | undefined> {
        try {
            const updatedFilters = await FilterUpdateApi.autoUpdateFilters(true);

            toasts.showFiltersUpdatedAlertMessage(true, updatedFilters);
            listeners.notifyListeners(listeners.FiltersUpdateCheckReady, updatedFilters);

            return updatedFilters;
        } catch (e) {
            toasts.showFiltersUpdatedAlertMessage(false);
            listeners.notifyListeners(listeners.FiltersUpdateCheckReady);
        }
    }

    /**
     * Called at the request to use optimized filters.
     */
    private static async onOptimizedFiltersSwitch(): Promise<void> {
        await FiltersApi.reloadEnabledFilters();
        Engine.debounceUpdate();
    }

    /**
     * Called when prompted to disable or enable hit collection.
     *
     * @param value Desired collecting status.
     */
    private static async onCollectHitsSwitch(value: boolean): Promise<void> {
        if (value) {
            HitStatsApi.cleanup();
        }
    }

    /**
     * Called on a request to reset the counters of blocked ads.
     */
    private static async resetBlockedAdsCount(): Promise<void> {
        await PageStatsApi.reset();
    }

    /**
     * Enables specified group and updates filter engine.
     *
     * On first group activation we provide recommended filters,
     * that will be loaded end enabled before update checking.
     *
     * @see Categories.enableGroup
     *
     * @param groupId Id of filter group.
     * @param recommendedFiltersIds Array of filters ids to enable on first time the group has been activated.
     */
    private static async enableGroup(groupId: number, recommendedFiltersIds: number[] = []): Promise<void> {
        await Categories.enableGroup(groupId, recommendedFiltersIds);
        Engine.debounceUpdate();
    }

    /**
     * Loads and enables specified filter and updates filter engine.
     * If filter group has not been touched before, it will be activated.
     *
     * @param filterId Id of filter.
     */
    private static async enableFilter(filterId: number): Promise<void> {
        await FiltersApi.loadAndEnableFilters([filterId], true);
        Engine.debounceUpdate();
    }
}
