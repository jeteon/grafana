import _ from 'lodash';
import {
  ensureQueries,
  getQueryKeys,
  parseUrlState,
  DEFAULT_UI_STATE,
  generateNewKeyAndAddRefIdIfMissing,
  sortLogsResult,
  stopQueryState,
  refreshIntervalToSortOrder,
  instanceOfDataQueryError,
} from 'app/core/utils/explore';
import { ExploreItemState, ExploreState, ExploreId, ExploreUpdateState, ExploreMode } from 'app/types/explore';
import { LoadingState } from '@grafana/data';
import { DataQuery, PanelData } from '@grafana/ui';
import {
  HigherOrderAction,
  ActionTypes,
  testDataSourcePendingAction,
  testDataSourceSuccessAction,
  testDataSourceFailureAction,
  splitCloseAction,
  SplitCloseActionPayload,
  loadExploreDatasources,
  historyUpdatedAction,
  changeModeAction,
  setUrlReplacedAction,
  scanStopAction,
  queryStartAction,
  changeRangeAction,
  addQueryRowAction,
  changeQueryAction,
  changeSizeAction,
  changeRefreshIntervalAction,
  clearQueriesAction,
  highlightLogsExpressionAction,
  initializeExploreAction,
  updateDatasourceInstanceAction,
  loadDatasourceMissingAction,
  loadDatasourcePendingAction,
  loadDatasourceReadyAction,
  modifyQueriesAction,
  removeQueryRowAction,
  scanStartAction,
  setQueriesAction,
  toggleTableAction,
  queriesImportedAction,
  updateUIStateAction,
  toggleLogLevelAction,
  changeLoadingStateAction,
  resetExploreAction,
  queryEndedAction,
  queryStreamUpdatedAction,
  QueryEndedPayload,
  setPausedStateAction,
} from './actionTypes';
import { reducerFactory, ActionOf } from 'app/core/redux';
import { updateLocation } from 'app/core/actions/location';
import { LocationUpdate } from '@grafana/runtime';
import TableModel from 'app/core/table_model';
import { isLive } from '@grafana/ui/src/components/RefreshPicker/RefreshPicker';
import { PanelQueryState, toDataQueryError } from '../../dashboard/state/PanelQueryState';
import { ResultProcessor } from '../utils/ResultProcessor';

export const DEFAULT_RANGE = {
  from: 'now-6h',
  to: 'now',
};

// Millies step for helper bar charts
const DEFAULT_GRAPH_INTERVAL = 15 * 1000;

export const makeInitialUpdateState = (): ExploreUpdateState => ({
  datasource: false,
  queries: false,
  range: false,
  mode: false,
  ui: false,
});

/**
 * Returns a fresh Explore area state
 */
export const makeExploreItemState = (): ExploreItemState => ({
  StartPage: undefined,
  containerWidth: 0,
  datasourceInstance: null,
  requestedDatasourceName: null,
  datasourceError: null,
  datasourceLoading: null,
  datasourceMissing: false,
  exploreDatasources: [],
  history: [],
  queries: [],
  initialized: false,
  queryIntervals: { interval: '15s', intervalMs: DEFAULT_GRAPH_INTERVAL },
  range: {
    from: null,
    to: null,
    raw: DEFAULT_RANGE,
  },
  absoluteRange: {
    from: null,
    to: null,
  },
  scanning: false,
  scanRange: null,
  showingGraph: true,
  showingTable: true,
  loading: false,
  queryKeys: [],
  urlState: null,
  update: makeInitialUpdateState(),
  latency: 0,
  supportedModes: [],
  mode: null,
  isLive: false,
  isPaused: false,
  urlReplaced: false,
  queryState: new PanelQueryState(),
  queryResponse: createEmptyQueryResponse(),
});

export const createEmptyQueryResponse = (): PanelData => ({
  state: LoadingState.NotStarted,
  request: null,
  series: [],
  legacy: null,
  error: null,
});

/**
 * Global Explore state that handles multiple Explore areas and the split state
 */
export const initialExploreItemState = makeExploreItemState();
export const initialExploreState: ExploreState = {
  split: null,
  left: initialExploreItemState,
  right: initialExploreItemState,
};

/**
 * Reducer for an Explore area, to be used by the global Explore reducer.
 */
export const itemReducer = reducerFactory<ExploreItemState>({} as ExploreItemState)
  .addMapper({
    filter: addQueryRowAction,
    mapper: (state, action): ExploreItemState => {
      const { queries } = state;
      const { index, query } = action.payload;

      // Add to queries, which will cause a new row to be rendered
      const nextQueries = [...queries.slice(0, index + 1), { ...query }, ...queries.slice(index + 1)];

      return {
        ...state,
        queries: nextQueries,
        logsHighlighterExpressions: undefined,
        queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
      };
    },
  })
  .addMapper({
    filter: changeQueryAction,
    mapper: (state, action): ExploreItemState => {
      const { queries } = state;
      const { query, index } = action.payload;

      // Override path: queries are completely reset
      const nextQuery: DataQuery = generateNewKeyAndAddRefIdIfMissing(query, queries, index);
      const nextQueries = [...queries];
      nextQueries[index] = nextQuery;

      return {
        ...state,
        queries: nextQueries,
        queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
      };
    },
  })
  .addMapper({
    filter: changeSizeAction,
    mapper: (state, action): ExploreItemState => {
      const containerWidth = action.payload.width;
      return { ...state, containerWidth };
    },
  })
  .addMapper({
    filter: changeModeAction,
    mapper: (state, action): ExploreItemState => {
      const mode = action.payload.mode;
      return { ...state, mode };
    },
  })
  .addMapper({
    filter: changeRefreshIntervalAction,
    mapper: (state, action): ExploreItemState => {
      const { refreshInterval } = action.payload;
      const live = isLive(refreshInterval);
      const sortOrder = refreshIntervalToSortOrder(refreshInterval);
      const logsResult = sortLogsResult(state.logsResult, sortOrder);
      if (isLive(state.refreshInterval) && !live) {
        stopQueryState(state.queryState, 'Live streaming stopped');
      }

      return {
        ...state,
        refreshInterval,
        queryResponse: {
          ...state.queryResponse,
          state: live ? LoadingState.Streaming : LoadingState.NotStarted,
        },
        isLive: live,
        isPaused: false,
        loading: live,
        logsResult,
      };
    },
  })
  .addMapper({
    filter: clearQueriesAction,
    mapper: (state): ExploreItemState => {
      const queries = ensureQueries();
      stopQueryState(state.queryState, 'Queries cleared');
      return {
        ...state,
        queries: queries.slice(),
        graphResult: null,
        tableResult: null,
        logsResult: null,
        showingStartPage: Boolean(state.StartPage),
        queryKeys: getQueryKeys(queries, state.datasourceInstance),
        queryResponse: createEmptyQueryResponse(),
        loading: false,
      };
    },
  })
  .addMapper({
    filter: highlightLogsExpressionAction,
    mapper: (state, action): ExploreItemState => {
      const { expressions } = action.payload;
      return { ...state, logsHighlighterExpressions: expressions };
    },
  })
  .addMapper({
    filter: initializeExploreAction,
    mapper: (state, action): ExploreItemState => {
      const { containerWidth, eventBridge, queries, range, mode, ui } = action.payload;
      return {
        ...state,
        containerWidth,
        eventBridge,
        range,
        mode,
        queries,
        initialized: true,
        queryKeys: getQueryKeys(queries, state.datasourceInstance),
        ...ui,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: updateDatasourceInstanceAction,
    mapper: (state, action): ExploreItemState => {
      const { datasourceInstance } = action.payload;
      // Capabilities
      const supportsGraph = datasourceInstance.meta.metrics;
      const supportsLogs = datasourceInstance.meta.logs;

      let mode = state.mode || ExploreMode.Metrics;
      const supportedModes: ExploreMode[] = [];

      if (supportsGraph) {
        supportedModes.push(ExploreMode.Metrics);
      }

      if (supportsLogs) {
        supportedModes.push(ExploreMode.Logs);
      }

      if (supportedModes.length === 1) {
        mode = supportedModes[0];
      }

      // Custom components
      const StartPage = datasourceInstance.components.ExploreStartPage;
      stopQueryState(state.queryState, 'Datasource changed');

      return {
        ...state,
        datasourceInstance,
        graphResult: null,
        tableResult: null,
        logsResult: null,
        latency: 0,
        queryResponse: createEmptyQueryResponse(),
        loading: false,
        StartPage,
        showingStartPage: Boolean(StartPage),
        queryKeys: [],
        supportedModes,
        mode,
      };
    },
  })
  .addMapper({
    filter: loadDatasourceMissingAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        datasourceMissing: true,
        datasourceLoading: false,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: loadDatasourcePendingAction,
    mapper: (state, action): ExploreItemState => {
      return {
        ...state,
        datasourceLoading: true,
        requestedDatasourceName: action.payload.requestedDatasourceName,
      };
    },
  })
  .addMapper({
    filter: loadDatasourceReadyAction,
    mapper: (state, action): ExploreItemState => {
      const { history } = action.payload;
      return {
        ...state,
        history,
        datasourceLoading: false,
        datasourceMissing: false,
        logsHighlighterExpressions: undefined,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: modifyQueriesAction,
    mapper: (state, action): ExploreItemState => {
      const { queries } = state;
      const { modification, index, modifier } = action.payload;
      let nextQueries: DataQuery[];
      if (index === undefined) {
        // Modify all queries
        nextQueries = queries.map((query, i) => {
          const nextQuery = modifier({ ...query }, modification);
          return generateNewKeyAndAddRefIdIfMissing(nextQuery, queries, i);
        });
      } else {
        // Modify query only at index
        nextQueries = queries.map((query, i) => {
          if (i === index) {
            const nextQuery = modifier({ ...query }, modification);
            return generateNewKeyAndAddRefIdIfMissing(nextQuery, queries, i);
          }

          return query;
        });
      }
      return {
        ...state,
        queries: nextQueries,
        queryKeys: getQueryKeys(nextQueries, state.datasourceInstance),
      };
    },
  })
  .addMapper({
    filter: queryStartAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        latency: 0,
        queryResponse: {
          ...state.queryResponse,
          state: LoadingState.Loading,
          error: null,
        },
        loading: true,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: removeQueryRowAction,
    mapper: (state, action): ExploreItemState => {
      const { queries, queryKeys } = state;
      const { index } = action.payload;

      if (queries.length <= 1) {
        return state;
      }

      const nextQueries = [...queries.slice(0, index), ...queries.slice(index + 1)];
      const nextQueryKeys = [...queryKeys.slice(0, index), ...queryKeys.slice(index + 1)];

      return {
        ...state,
        queries: nextQueries,
        logsHighlighterExpressions: undefined,
        queryKeys: nextQueryKeys,
      };
    },
  })
  .addMapper({
    filter: scanStartAction,
    mapper: (state, action): ExploreItemState => {
      return { ...state, scanning: true };
    },
  })
  .addMapper({
    filter: scanStopAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        scanning: false,
        scanRange: undefined,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: setQueriesAction,
    mapper: (state, action): ExploreItemState => {
      const { queries } = action.payload;
      return {
        ...state,
        queries: queries.slice(),
        queryKeys: getQueryKeys(queries, state.datasourceInstance),
      };
    },
  })
  .addMapper({
    filter: updateUIStateAction,
    mapper: (state, action): ExploreItemState => {
      return { ...state, ...action.payload };
    },
  })
  .addMapper({
    filter: toggleTableAction,
    mapper: (state): ExploreItemState => {
      const showingTable = !state.showingTable;
      if (showingTable) {
        return { ...state };
      }

      return { ...state, tableResult: new TableModel() };
    },
  })
  .addMapper({
    filter: queriesImportedAction,
    mapper: (state, action): ExploreItemState => {
      const { queries } = action.payload;
      return {
        ...state,
        queries,
        queryKeys: getQueryKeys(queries, state.datasourceInstance),
      };
    },
  })
  .addMapper({
    filter: toggleLogLevelAction,
    mapper: (state, action): ExploreItemState => {
      const { hiddenLogLevels } = action.payload;
      return {
        ...state,
        hiddenLogLevels: Array.from(hiddenLogLevels),
      };
    },
  })
  .addMapper({
    filter: testDataSourcePendingAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        datasourceError: null,
      };
    },
  })
  .addMapper({
    filter: testDataSourceSuccessAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        datasourceError: null,
      };
    },
  })
  .addMapper({
    filter: testDataSourceFailureAction,
    mapper: (state, action): ExploreItemState => {
      return {
        ...state,
        datasourceError: action.payload.error,
        graphResult: undefined,
        tableResult: undefined,
        logsResult: undefined,
        update: makeInitialUpdateState(),
      };
    },
  })
  .addMapper({
    filter: loadExploreDatasources,
    mapper: (state, action): ExploreItemState => {
      return {
        ...state,
        exploreDatasources: action.payload.exploreDatasources,
      };
    },
  })
  .addMapper({
    filter: historyUpdatedAction,
    mapper: (state, action): ExploreItemState => {
      return {
        ...state,
        history: action.payload.history,
      };
    },
  })
  .addMapper({
    filter: setUrlReplacedAction,
    mapper: (state): ExploreItemState => {
      return {
        ...state,
        urlReplaced: true,
      };
    },
  })
  .addMapper({
    filter: changeRangeAction,
    mapper: (state, action): ExploreItemState => {
      const { range, absoluteRange } = action.payload;
      return {
        ...state,
        range,
        absoluteRange,
      };
    },
  })
  .addMapper({
    filter: changeLoadingStateAction,
    mapper: (state, action): ExploreItemState => {
      const { loadingState } = action.payload;
      return {
        ...state,
        queryResponse: {
          ...state.queryResponse,
          state: loadingState,
        },
        loading: loadingState === LoadingState.Loading || loadingState === LoadingState.Streaming,
      };
    },
  })
  .addMapper({
    filter: setPausedStateAction,
    mapper: (state, action): ExploreItemState => {
      const { isPaused } = action.payload;
      return {
        ...state,
        isPaused: isPaused,
      };
    },
  })
  .addMapper({
    //queryStreamUpdatedAction
    filter: queryEndedAction,
    mapper: (state, action): ExploreItemState => {
      return processQueryResponse(state, action);
    },
  })
  .addMapper({
    filter: queryStreamUpdatedAction,
    mapper: (state, action): ExploreItemState => {
      return processQueryResponse(state, action);
    },
  })
  .create();

export const processQueryResponse = (
  state: ExploreItemState,
  action: ActionOf<QueryEndedPayload>
): ExploreItemState => {
  const { response } = action.payload;
  const { request, state: loadingState, series, legacy, error } = response;
  const replacePreviousResults = action.type === queryEndedAction.type;

  if (error) {
    if (error.cancelled) {
      return state;
    }

    // For Angular editors
    state.eventBridge.emit('data-error', error);

    console.error(error); // To help finding problems with query syntax

    if (!instanceOfDataQueryError(error)) {
      response.error = toDataQueryError(error);
    }

    return {
      ...state,
      loading: false,
      queryResponse: response,
      graphResult: null,
      tableResult: null,
      logsResult: null,
      showingStartPage: false,
      update: makeInitialUpdateState(),
    };
  }

  const latency = request.endTime - request.startTime;
  const processor = new ResultProcessor(state, replacePreviousResults, series);

  // For Angular editors
  state.eventBridge.emit('data-received', legacy);

  return {
    ...state,
    latency,
    queryResponse: response,
    graphResult: processor.getGraphResult(),
    tableResult: processor.getTableResult(),
    logsResult: processor.getLogsResult(),
    loading: loadingState === LoadingState.Loading || loadingState === LoadingState.Streaming,
    showingStartPage: false,
    update: makeInitialUpdateState(),
  };
};

export const updateChildRefreshState = (
  state: Readonly<ExploreItemState>,
  payload: LocationUpdate,
  exploreId: ExploreId
): ExploreItemState => {
  const path = payload.path || '';
  const queryState = payload.query[exploreId] as string;
  if (!queryState) {
    return state;
  }

  const urlState = parseUrlState(queryState);
  if (!state.urlState || path !== '/explore') {
    // we only want to refresh when browser back/forward
    return {
      ...state,
      urlState,
      update: { datasource: false, queries: false, range: false, mode: false, ui: false },
    };
  }

  const datasource = _.isEqual(urlState ? urlState.datasource : '', state.urlState.datasource) === false;
  const queries = _.isEqual(urlState ? urlState.queries : [], state.urlState.queries) === false;
  const range = _.isEqual(urlState ? urlState.range : DEFAULT_RANGE, state.urlState.range) === false;
  const mode = _.isEqual(urlState ? urlState.mode : ExploreMode.Metrics, state.urlState.mode) === false;
  const ui = _.isEqual(urlState ? urlState.ui : DEFAULT_UI_STATE, state.urlState.ui) === false;

  return {
    ...state,
    urlState,
    update: {
      ...state.update,
      datasource,
      queries,
      range,
      mode,
      ui,
    },
  };
};

/**
 * Global Explore reducer that handles multiple Explore areas (left and right).
 * Actions that have an `exploreId` get routed to the ExploreItemReducer.
 */
export const exploreReducer = (state = initialExploreState, action: HigherOrderAction): ExploreState => {
  switch (action.type) {
    case splitCloseAction.type: {
      const { itemId } = action.payload as SplitCloseActionPayload;
      const targetSplit = {
        left: itemId === ExploreId.left ? state.right : state.left,
        right: initialExploreState.right,
      };
      return {
        ...state,
        ...targetSplit,
        split: false,
      };
    }

    case ActionTypes.SplitOpen: {
      return { ...state, split: true, right: { ...action.payload.itemState } };
    }

    case ActionTypes.ResetExplore: {
      return initialExploreState;
    }

    case updateLocation.type: {
      const { query } = action.payload;
      if (!query || !query[ExploreId.left]) {
        return state;
      }

      const split = query[ExploreId.right] ? true : false;
      const leftState = state[ExploreId.left];
      const rightState = state[ExploreId.right];

      return {
        ...state,
        split,
        [ExploreId.left]: updateChildRefreshState(leftState, action.payload, ExploreId.left),
        [ExploreId.right]: updateChildRefreshState(rightState, action.payload, ExploreId.right),
      };
    }

    case resetExploreAction.type: {
      const leftState = state[ExploreId.left];
      const rightState = state[ExploreId.right];
      stopQueryState(leftState.queryState, 'Navigated away from Explore');
      stopQueryState(rightState.queryState, 'Navigated away from Explore');

      return {
        ...state,
        [ExploreId.left]: updateChildRefreshState(leftState, action.payload, ExploreId.left),
        [ExploreId.right]: updateChildRefreshState(rightState, action.payload, ExploreId.right),
      };
    }
  }

  if (action.payload) {
    const { exploreId } = action.payload as any;
    if (exploreId !== undefined) {
      // @ts-ignore
      const exploreItemState = state[exploreId];
      return { ...state, [exploreId]: itemReducer(exploreItemState, action) };
    }
  }

  return state;
};

export default {
  explore: exploreReducer,
};
