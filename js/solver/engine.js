"use strict";

class SudokuSolver {
  constructor(handlers, shape, debugOptions) {
    this._debugLogger = new SudokuSolver.DebugLogger(this, debugOptions);
    this._shape = shape;

    this._internalSolver = new SudokuSolver.InternalSolver(
      handlers, shape, this._debugLogger);

    this._progressExtraStateFn = null;
    this._progressCallback = null;

    this._reset();
  }

  _reset() {
    this._internalSolver.reset();
    this._iter = null;
    this._timer = new Timer();
  }

  setProgressCallback(callback, logFrequency) {
    this._progressCallback = callback;
    this._internalSolver.setProgressCallback(
      this._sendProgress.bind(this),
      logFrequency);
  }

  _sendProgress() {
    let extraState = null;
    if (this._progressExtraStateFn) extraState = this._progressExtraStateFn();
    if (this._progressCallback) this._progressCallback(extraState);
  }

  countSolutions() {
    this._reset();

    // Add a sample solution to the state updates, but only if a different
    // solution is ready.
    let sampleSolution = null;
    this._progressExtraStateFn = () => {
      let result = null;
      if (sampleSolution) {
        result = { solutions: [sampleSolution] };
        sampleSolution = null;
      }
      return result;
    };

    this._timer.runTimed(() => {
      for (const result of this._getIter()) {
        // Only store a sample solution if we don't have one.
        if (sampleSolution == null) {
          sampleSolution = SudokuSolver.Util.gridToSolution(result.grid);
        }
      }
    });

    // Send progress one last time to ensure the last solution is sent.
    this._sendProgress();

    this._progressExtraStateFn = null;

    return this._internalSolver.counters.solutions;
  }

  nthSolution(n) {
    let result = this._nthIteration(n, false);
    if (!result) return null;

    return SudokuSolver.Util.gridToSolution(result.grid);
  }

  nthStep(n, stepGuides) {
    const result = this._nthIteration(n, stepGuides);
    if (!result) return null;

    const pencilmarks = SudokuSolver.Util.makePencilmarks(result.grid);
    for (const cell of result.cellOrder) {
      pencilmarks[cell] = LookupTables.toValue(result.grid[cell]);
    }

    let diffPencilmarks = null;
    if (result.oldGrid) {
      const diff = SudokuSolver.Util.gridDifference(
        result.oldGrid, result.grid);
      diffPencilmarks = SudokuSolver.Util.makePencilmarks(result.oldGrid);
    }

    const latestCell = result.cellOrder.length ?
      this._shape.makeCellIdFromIndex(
        result.cellOrder[result.cellOrder.length - 1]) : null;

    return {
      pencilmarks: pencilmarks,
      diffPencilmarks: diffPencilmarks,
      latestCell: latestCell,
      isSolution: result.isSolution,
      hasContradiction: result.hasContradiction,
      values: LookupTables.toValuesArray(result.values),
    }
  }

  _nthIteration(n, stepGuides) {
    const yieldEveryStep = !!stepGuides;

    n++;
    let iter = this._getIter(yieldEveryStep);
    // To go backwards we start from the start.
    if (n <= iter.count) {
      this._reset();
      iter = this._getIter(yieldEveryStep);
    }

    if (yieldEveryStep) {
      this._internalSolver.setStepState({
        stepGuides: stepGuides,
      });
      this._debugLogger.enableStepLogs = false;
    }

    // Iterate until we have seen n steps.
    let result = null;
    this._timer.runTimed(() => {
      do {
        // Only show debug logs for the target step.
        if (yieldEveryStep && this._debugLogger.enableLogs && iter.count == n - 1) {
          this._debugLogger.enableStepLogs = true;
          this._debugLogger.log({
            loc: 'nthStep',
            msg: 'Step ' + iter.count,
            important: true
          });
        }
        result = iter.next();
      } while (iter.count < n);
    });

    if (result.done) return null;
    return result.value;
  }

  solveAllPossibilities() {
    this._reset();

    let valuesInSolutions = new Uint16Array(this._shape.numCells);
    let solutions = [];

    // Send the current values with the progress update, if there have
    // been any changes.
    this._progressExtraStateFn = () => {
      if (!solutions.length) return null;
      return {
        solutions: solutions.splice(0).map(
          s => SudokuSolver.Util.gridToSolution(s)),
      };
    };

    this._timer.runTimed(() => {
      this._internalSolver.solveAllPossibilities(solutions, valuesInSolutions);
    });

    // Send progress one last time to ensure all the solutions are sent.
    this._sendProgress();
    this._progressExtraStateFn = null;

    return SudokuSolver.Util.makePencilmarks(valuesInSolutions);
  }

  validateLayout() {
    this._reset();

    let result = false;
    this._timer.runTimed(() => {
      result = this._internalSolver.validateLayout();
    });

    return result;
  }

  debugState() {
    return this._debugLogger.getDebugState();
  }

  state() {
    const counters = { ...this._internalSolver.counters };

    const state = {
      counters: counters,
      timeMs: this._timer.elapsedMs(),
      done: this._internalSolver.done,
    }

    return state;
  }

  _getIter(yieldEveryStep) {
    // If an iterator doesn't exist or is of the wrong type, then create it.
    if (!this._iter || this._iter.yieldEveryStep != yieldEveryStep) {
      this._iter = {
        yieldEveryStep: yieldEveryStep,
        iter: new IteratorWithCount(this._internalSolver.run(
          yieldEveryStep
            ? SudokuSolver.InternalSolver.YIELD_ON_STEP
            : SudokuSolver.InternalSolver.YIELD_ON_SOLUTION))
      };
    }

    return this._iter.iter;
  }
}

SudokuSolver.Util = class {
  static gridToSolution(grid) {
    return grid.map(value => LookupTables.toValue(value));
  }

  static makePencilmarks(grid) {
    const pencilmarks = [];
    for (let i = 0; i < grid.length; i++) {
      pencilmarks.push(new Set(
        LookupTables.toValuesArray(grid[i])));
    }
    return pencilmarks;
  }

  static gridDifference(gridA, gridB) {
    for (let i = 0; i < gridA.length; i++) {
      gridA[i] &= ~gridB[i];
    }
  }
};

SudokuSolver.DebugLogger = class {
  constructor(solver, debugOptions) {
    this._solver = solver;
    this._debugOptions = {
      logLevel: 0,
      enableStepLogs: false,
      exportBacktrackCounts: false,
    };
    this._hasAnyDebugging = false;
    this._pendingDebugLogs = [];

    if (debugOptions) {
      // Only copy over options for known values.
      for (const key of Object.keys(debugOptions)) {
        if (key in this._debugOptions) {
          this._debugOptions[key] = debugOptions[key];
          this._hasAnyDebugging ||= !!debugOptions[key];
        }
      }
    }

    this.logLevel = +this._debugOptions.logLevel;
    this.enableLogs = this.logLevel > 0;
    this.enableStepLogs = this._debugOptions.enableStepLogs;
  }

  log(data, level) {
    if (!this.enableLogs) {
      // We throw so we catch accidentally checked calls to log() because
      // they would hurt performance (even just creating the data object).
      throw ('Debug logs are not enabled');
    }

    level ||= 1;
    if (level > this.logLevel) return;

    this._pendingDebugLogs.push(data);
  }

  getDebugState() {
    if (!this._hasAnyDebugging) return null;

    const result = {};
    if (this._pendingDebugLogs.length) {
      result.logs = this._pendingDebugLogs.splice(0);
    }
    if (this._debugOptions.exportBacktrackCounts) {
      result.backtrackCounts = this._solver._internalSolver.getBacktrackTriggers();
    }
    return result;
  }
};

SudokuSolver.InternalSolver = class {

  constructor(handlerGen, shape, debugLogger) {
    this._shape = shape;
    this._numCells = this._shape.numCells;
    this._debugLogger = debugLogger;

    this._initGrid();
    this._recStack = new Uint16Array(shape.numCells + 1);
    this._progressRemainingStack = Array.from(this._recStack).fill(0.0);

    this._runCounter = 0;
    this._progress = {
      frequencyMask: -1,
      callback: null,
    };

    this._handlerSet = this._setUpHandlers(Array.from(handlerGen));

    this._handlerAccumulator = new SudokuSolver.HandlerAccumulator(this._handlerSet);
    this._candidateSelector = new SudokuSolver.CandidateSelector(
      shape, this._handlerSet, debugLogger);

    this._cellPriorities = this._initCellPriorities();

    this.reset();
  }

  // Cell priorities are used to determine the order in which cells are
  // searched with preference given to cells with higher priority.
  _initCellPriorities() {
    const priorities = new Int32Array(this._shape.numCells);

    // TODO: Determine priorities in a more principled way.
    //  - Add one for each exclusion cell.
    //  - Add custom priorities for each constraint based on how restrictive it
    //    is.

    for (const handler of this._handlerSet) {
      const priority = handler.priority();
      for (const cell of handler.cells) {
        priorities[cell] += priority;
      }
    }

    for (const handler of this._handlerSet.getAllofType(SudokuConstraintHandler.Priority)) {
      for (const cell of handler.priorityCells()) {
        priorities[cell] = handler.priority();
      }
    }

    if (this._debugLogger.enableLogs) {
      this._debugLogger.log({
        loc: '_initCellPriorities',
        msg: 'Hover for values',
        args: {
          min: Math.min(...priorities),
          max: Math.max(...priorities),
        },
        overlay: priorities,
      });
    }

    return priorities;
  }

  // Invalidate the grid, given the handler which said it was impossible.
  // We invalidate the grid by setting cells to zero. We want to set the
  // most meaningful cells to the user.
  _invalidateGrid(grid, handler) {
    // Try to use the handler cells.
    let cells = handler.cells;
    // Otherwise use the exclusionCells.
    if (!cells.length) cells = handler.exclusionCells();
    cells.forEach(c => grid[c] = 0);

    // Otherwise just set the entire grid to 0.
    if (!cells.length) grid.fill(0);
  }

  _setUpHandlers(handlers) {
    // Sort initial handlers so that the solver performance doesn't
    // depend on the input order.
    // TODO: Do this in a more principled way. Consider doing this
    //       twice - once now and once after the optimizer runs.
    handlers.sort((a, b) => {
      // Put the handlers with the least cells first.
      // This just worked out better.
      // Most puzzles don't seem to depend too much on this order, but
      // it makes a 2x difference for some.
      if (a.cells.length != b.cells.length) {
        return a.cells.length - b.cells.length;
      }
      // After this it doesn't matter, as long as it is deterministic.
      // There still might be equal handlers after comparing cells and
      // the handler type, but that is ok.
      if (a.constructor.name != b.constructor.name) {
        return a.constructor.name.localeCompare(b.constructor.name);
      }
      // Put cell comparison last as it is the most expensive.
      const aCells = a.cells.join(',');
      const bCells = b.cells.join(',');
      return aCells.localeCompare(bCells);
    });

    const handlerSet = new HandlerSet(handlers, this._shape);

    // Create lookups for which cells must have mutually exclusive values.
    const cellExclusions = new SudokuSolver.CellExclusions(
      handlerSet, this._shape);
    this._cellExclusions = cellExclusions;

    // Optimize handlers.
    new SudokuConstraintOptimizer(this._debugLogger).optimize(
      handlerSet, cellExclusions, this._shape);

    // Add the exclusion handlers.
    for (let i = 0; i < this._numCells; i++) {
      handlerSet.addExclusionHandlers(
        new SudokuConstraintHandler.ExclusionEnforcer(i));
    }

    // Initialize handlers.
    for (const handler of handlerSet) {
      if (!handler.initialize(this._initialGrid, cellExclusions, this._shape)) {
        this._invalidateGrid(this._initialGrid, handler);
      }
    }

    return handlerSet;
  }

  reset() {
    this._iter = null;
    this._stepState = null;
    this.counters = {
      valuesTried: 0,
      nodesSearched: 0,
      backtracks: 0,
      guesses: 0,
      solutions: 0,
      constraintsProcessed: 0,
      progressRatio: 0,
      progressRatioPrev: 0,
      branchesIgnored: 0,
    };

    // _backtrackTriggers counts the the number of times a cell is responsible
    // for finding a contradiction and causing a backtrack. It is exponentially
    // decayed so that the information reflects the most recent search areas.
    // Cells with a high count are the best candidates for searching as we
    // may find the contradiction faster. Ideally, this allows the search to
    // learn the critical areas of the grid where it is more valuable to search
    // first.
    // _backtrackTriggers are initialized to the cell priorities so that
    // so that the initial part of the search is still able to prioritize cells
    // which may lead to a contradiction.
    // NOTE: _backtrackTriggers must not be reassigned as we pass the reference
    // to the candidateSelector.
    this._backtrackTriggers = this._cellPriorities.slice();
    this._uninterestingValues = null;

    this._resetStack();
  }

  getBacktrackTriggers() {
    return this._backtrackTriggers.slice();
  }

  _resetStack() {
    // Candidate selector must be reset each time, because backtrackTriggers
    // object may have changed.
    this._candidateSelector.reset(this._backtrackTriggers);

    // If we are at the start anyway, then there is nothing else to do.
    if (this._atStart) return;

    this._runCounter++;

    this.done = false;
    this._atStart = true;
    this._grids[0].set(this._initialGrid);
    this._progressRemainingStack[0] = 1.0;
  }

  _initGrid() {
    const numCells = this._numCells;

    let buffer = new ArrayBuffer(
      (numCells + 1) * numCells * Uint16Array.BYTES_PER_ELEMENT);

    this._grids = [];
    for (let i = 0; i < numCells + 1; i++) {
      this._grids.push(new Uint16Array(
        buffer,
        i * numCells * Uint16Array.BYTES_PER_ELEMENT,
        numCells));
    }
    this._initialGrid = new Uint16Array(numCells);

    const allValues = LookupTables.get(this._shape.numValues).allValues;
    this._initialGrid.fill(allValues);
  }

  _hasInterestingSolutions(grid, uninterestingValues) {
    // We need to check all cells because we maybe validating a cell above
    // us, or finding a value for a cell below us.
    for (let cell = 0; cell < this._numCells; cell++) {
      if (grid[cell] & ~uninterestingValues[cell]) return true;
    }
    return false;
  }

  static _debugGridBuffer = new Uint16Array(SHAPE_MAX.numCells);

  _debugEnforceConsistency(loc, grid, handler, handlerAccumulator) {
    const oldGrid = this.constructor._debugGridBuffer;
    oldGrid.set(grid);

    const result = handler.enforceConsistency(grid, handlerAccumulator);
    const diff = {};
    let hasDiff = false;
    for (let i = 0; i < grid.length; i++) {
      if (oldGrid[i] != grid[i]) {
        diff[this._shape.makeCellIdFromIndex(i)] = (
          LookupTables.toValuesArray(oldGrid[i] & ~grid[i]));
        hasDiff = true;
      }
    }

    if (hasDiff) {
      this._debugLogger.log({
        loc: loc,
        msg: `${handler.constructor.name} removed: `,
        args: diff,
        cells: handler.cells,
      });
    } else if (this._debugLogger.logLevel >= 2) {
      this._debugLogger.log({
        loc: loc,
        msg: `${handler.constructor.name} ran`,
        cells: handler.cells,
      }, 2);
    }
    if (!result) {
      this._debugLogger.log({
        loc: loc,
        msg: `${handler.constructor.name} returned false`,
        cells: handler.cells,
      });
    }

    return result;
  }

  _enforceConstraints(grid, gridIsComplete, handlerAccumulator) {
    const counters = this.counters;
    const logSteps = this._debugLogger.enableStepLogs;

    while (!handlerAccumulator.isEmpty()) {
      const c = handlerAccumulator.takeNext();
      if (gridIsComplete && !c.essential) continue;
      counters.constraintsProcessed++;
      if (logSteps) {
        if (!this._debugEnforceConsistency('_enforceConstraints', grid, c, handlerAccumulator)) {
          return false;
        }
      } else {
        // TODO: Avoid c being added to handlerAccumulator during this time.
        if (!c.enforceConsistency(grid, handlerAccumulator)) {
          return false;
        }
      }
    }

    return true;
  }

  setStepState(updates) {
    if (this._stepState == null) {
      this._stepState = {
        stepGuides: null,
        step: 0,
        oldGrid: new Uint16Array(this._numCells),
      };
    }
    for (const [key, value] of Object.entries(updates)) {
      this._stepState[key] = value;
    }
  }

  static YIELD_ON_SOLUTION = 0;
  static YIELD_ON_STEP = 1;

  static _LOG_BACKTRACK_DECAY_INTERVAL = 14;

  // run runs the solve.
  // yieldWhen can be:
  //  YIELD_ON_SOLUTION to yielding each solution.
  //  YIELD_ON_STEP to yield every step.
  //  n > 1 to yield every n contradictions.
  * run(yieldWhen) {
    const yieldEveryStep = yieldWhen === this.constructor.YIELD_ON_STEP;
    const yieldOnContradiction = yieldWhen > 1 ? yieldWhen : 0;

    // Set up iterator validation.
    if (!this._atStart) throw ('State is not in initial state.');
    this._atStart = false;
    let runCounter = ++this._runCounter;
    const checkRunCounter = () => {
      if (runCounter != this._runCounter) throw ('Iterator no longer valid');
    };

    const counters = this.counters;
    counters.progressRatioPrev += counters.progressRatio;
    counters.progressRatio = 0;

    const progressFrequencyMask = this._progress.frequencyMask;
    const backtrackDecayMask = (1 << this.constructor._LOG_BACKTRACK_DECAY_INTERVAL) - 1;
    let iterationCounterForUpdates = 0;

    {
      // Enforce constraints for all cells.
      const handlerAccumulator = this._handlerAccumulator;
      handlerAccumulator.clear();
      for (let i = 0; i < this._numCells; i++) handlerAccumulator.addForCell(i);
      this._enforceConstraints(this._grids[0], false, handlerAccumulator);
    }

    if (yieldEveryStep) {
      this.setStepState({});
      yield {
        grid: this._grids[0],
        oldGrid: null,
        isSolution: false,
        cellOrder: [],
        values: 0,
        hasContradiction: false,
      }
      checkRunCounter();
      this._stepState.step = 1;
    }

    let recDepth = 0;
    const recStack = this._recStack;
    recStack[recDepth++] = 0;
    let isNewNode = true;
    let progressDelta = 1.0;
    // The last cell which caused a contradiction at each level.
    const lastContradictionCell = new Int16Array(this._numCells);
    lastContradictionCell.fill(-1);

    while (recDepth) {
      recDepth--;
      const cellDepth = recStack[recDepth];

      let grid = this._grids[recDepth];

      const wasNewNode = isNewNode;

      if (isNewNode) {
        isNewNode = false;

        // We've reached the end, so output a solution!
        if (cellDepth == this._shape.numCells) {
          counters.progressRatio += progressDelta;
          // We've set all the values, and we haven't found a contradiction.
          // This is a solution!
          counters.solutions++;
          yield {
            grid: grid,
            isSolution: true,
            cellOrder: this._candidateSelector.getCellOrder(),
            hasContradiction: false,
          };
          checkRunCounter();
          continue;
        }

        this._progressRemainingStack[recDepth] = progressDelta;

        // Update counters.
        counters.nodesSearched++;
      }

      const [nextCells, value, count] =
        this._candidateSelector.selectNextCandidate(
          cellDepth, grid, this._stepState, wasNewNode);
      if (count === 0) continue;

      const nextDepth = cellDepth + nextCells.length;
      // The first nextCell maybe a guess, but the rest are singletons.
      const cell = nextCells[0];
      if (yieldEveryStep) {
        this._stepState.oldGrid.set(grid);
      }

      {
        // Assume the remaining progress is evenly distributed among the value
        // options.
        progressDelta = this._progressRemainingStack[recDepth] / count;
        this._progressRemainingStack[recDepth] -= progressDelta;


        // We are enforcing several values at once.
        counters.valuesTried += nextCells.length;

        iterationCounterForUpdates++;
        if ((iterationCounterForUpdates & backtrackDecayMask) === 0) {
          // Exponentially decay the counts.
          for (let i = 0; i < this._numCells; i++) {
            this._backtrackTriggers[i] >>= 1;
          }
          // Ensure that the counter doesn't overflow.
          iterationCounterForUpdates &= (1 << 30) - 1;
        }
      }

      if (count !== 1) {
        // We only need to start a new recursion frame when there is more than
        // one value to try.

        recDepth++;
        counters.guesses++;

        // Remove the value from our set of candidates.
        // NOTE: We only have to do this because we will return back to this
        //       stack frame.
        grid[cell] ^= value;

        this._grids[recDepth].set(grid);
        grid = this._grids[recDepth];
      }
      // NOTE: Set this even when count == 1 to allow for other candidate
      //       selection methods.
      grid[cell] = value;

      const gridIsComplete = (nextDepth == this._numCells);

      const handlerAccumulator = this._handlerAccumulator;
      handlerAccumulator.clear();
      for (let i = 0; i < nextCells.length; i++) {
        handlerAccumulator.addForFixedCell(nextCells[i]);
        if (!gridIsComplete) {
          handlerAccumulator.addAuxForCell(nextCells[i]);
        }
        handlerAccumulator.addForCell(nextCells[i]);
      }
      // Queue up extra constraints based on prior backtracks. The idea being
      // that constraints that apply this the contradiction cell are likely
      // to turn up a contradiction here if it exists.
      if (lastContradictionCell[cellDepth] >= 0) {
        handlerAccumulator.addForCell(lastContradictionCell[cellDepth]);
        // If this is the last value at this level, clear the
        // lastContradictionCell as the next time we reach this level won't be
        // from the same subtree that caused the contradiction.
        if (count === 1) lastContradictionCell[cellDepth] = -1;
      }

      // Propagate constraints.
      const hasContradiction = !this._enforceConstraints(
        grid, gridIsComplete, handlerAccumulator);
      if (hasContradiction) {
        // Store the current cells, so that the level immediately above us
        // can act on this information to run extra constraints.
        if (cellDepth > 0) lastContradictionCell[cellDepth - 1] = cell;
        counters.progressRatio += progressDelta;
        counters.backtracks++;
        this._backtrackTriggers[cell]++;

        if (0 !== yieldOnContradiction &&
          0 === counters.backtracks % yieldOnContradiction) {
          yield {
            grid: grid,
            isSolution: false,
            cellOrder: this._candidateSelector.getCellOrder(cellDepth),
            hasContradiction: hasContradiction,
          };
        }
      }

      if ((iterationCounterForUpdates & progressFrequencyMask) === 0) {
        this._progress.callback();
      }

      if (yieldEveryStep) {
        // The value may have been over-written by the constraint enforcer
        // (i.e. if there was a contradiction). Replace it for the output.
        grid[cell] = value;
        yield {
          grid: grid,
          oldGrid: this._stepState.oldGrid,
          isSolution: false,
          cellOrder: this._candidateSelector.getCellOrder(cellDepth + 1),
          values: this._stepState.oldGrid[cell],
          hasContradiction: hasContradiction,
        };
        checkRunCounter();
        this._stepState.step++;
      }

      if (hasContradiction) continue;

      if (this._uninterestingValues) {
        if (!this._hasInterestingSolutions(grid, this._uninterestingValues)) {
          counters.branchesIgnored += progressDelta;
          continue;
        }
      }

      // Recurse to the new cell, skipping past all the cells we enforced.
      recStack[recDepth++] = nextDepth;
      isNewNode = true;
    }

    this.done = true;
  }

  solveAllPossibilities(solutions, valuesInSolutions) {
    const counters = this.counters;

    for (const result of this.run()) {
      result.grid.forEach((c, i) => { valuesInSolutions[i] |= c; });
      solutions.push(result.grid.slice(0));

      // Once we have 2 solutions, then start ignoring branches which maybe
      // duplicating existing solution (up to this point, every branch is
      // interesting).
      if (counters.solutions == 2) {
        this._uninterestingValues = valuesInSolutions;
      }
    }
  }

  validateLayout() {
    // Choose just the house handlers.
    const houseHandlers = this._handlerSet.getAllofType(SudokuConstraintHandler.House);

    // Function to fill a house with all values.
    const fillHouse = (house) => {
      house.cells.forEach((c, i) => this._grids[0][c] = 1 << i);
    };

    const attemptLog = [];
    // Arbitrary search limit. Too much lower and there are some cases which get
    // stuck for too long.
    const SEARCH_LIMIT = 200;

    // Function to attempt to solve with one house fixed.
    const attempt = (house) => {
      this._resetStack();

      fillHouse(house);
      // Reduce backtrack triggers so that we don't weight the last runs too
      // heavily.
      // TODO: Do this in a more principled way.
      for (let i = 0; i < this._numCells; i++) {
        this._backtrackTriggers[i] >>= 1;
      }

      for (const result of this.run(SEARCH_LIMIT)) {
        if (result.isSolution) {
          this.counters.branchesIgnored = 1 - this.counters.progressRatio;
          return true;
        }
        attemptLog.push([house, this.counters.progressRatio]);
        return undefined;
      }
      return false;
    };

    // Try doing a short search from every house.
    for (const house of houseHandlers) {
      const result = attempt(house);
      // If the search completed, then we can return the result immediately.
      if (result !== undefined) {
        this.done = true;
        return result;
      }
    }

    // None of the searches completed. Choose the house which had the most
    // progress (i.e. the search covered more of the search space), and do
    // a full search from there.

    // Find the house with the best score.
    attemptLog.sort((a, b) => b[1] - a[1]);
    const bestHouse = attemptLog[0][0];

    this._resetStack();
    fillHouse(bestHouse);

    // Run the final search until we find a solution or prove that one doesn't
    // exist.
    let result = false;
    for (const _ of this.run()) { result = true; break; }

    this.done = true;
    return result;
  }

  setProgressCallback(callback, logFrequency) {
    this._progress.callback = callback;
    this._progress.frequencyMask = -1;
    if (callback) {
      this._progress.frequencyMask = (1 << logFrequency) - 1;
    }
  }

}

SudokuSolver.CandidateSelector = class CandidateSelector {
  constructor(shape, handlerSet, debugLogger) {
    this._shape = shape;
    this._cellOrder = new Uint8Array(shape.numCells);
    this._backtrackTriggers = null;
    this._debugLogger = debugLogger;

    this._candidateSelectionState = [];
    for (let i = 0; i < shape.numCells; i++) {
      this._candidateSelectionState.push(null);
    }

    const houseHandlerSet = new HandlerSet(
      handlerSet.getAllofType(SudokuConstraintHandler.House), shape);
    this._houseHandlerAccumulator = new SudokuSolver.HandlerAccumulator(
      houseHandlerSet);
  }

  reset(backtrackTriggers) {
    // Re-initialize the cell indexes in the cellOrder.
    // This is not required, but keeps things deterministic.
    const numCells = this._cellOrder.length;
    for (let i = 0; i < numCells; i++) {
      this._cellOrder[i] = i;
    }

    this._backtrackTriggers = backtrackTriggers;

    this._candidateSelectionState.fill(null);
  }

  getCellOrder(upto) {
    if (upto === undefined) return this._cellOrder;
    return this._cellOrder.subarray(0, upto);
  }

  // selectNextCandidate find the next candidate to try.
  // Returns [nextCells, value, count]:
  //   nextCells[0]: The cell which contains the next candidate.
  //   value: The candidate value in the nextCells[0].
  //   count: The number of options we selected from:
  //      - If `count` == 1, then this is a known value and the solver will
  //        not return to this node.
  //      - Most of the time, `count` will equal the number of values in
  //        nextCells[0], but it may be less if we are branching on something
  //        other than the cell (e.g. a digit within a house).
  //   nextCells[1:]: Singleton cells which can be enforced at the same time.
  selectNextCandidate(cellDepth, grid, stepState, isNewNode) {
    const cellOrder = this._cellOrder;
    let [cellOffset, value, count] = this._selectBestCandidate(
      grid, cellOrder, cellDepth, isNewNode);

    // Adjust the value for step-by-step.
    if (stepState) {
      if (this._debugLogger.enableStepLogs) {
        this._logSelectNextCandidate(
          'Best candidate:', cellOrder[cellOffset], value, count, cellDepth);
      }

      let adjusted = false;
      [cellOffset, value, adjusted] = this._adjustForStepState(
        stepState, grid, cellOrder, cellDepth, cellOffset, value);

      if (adjusted) {
        count = countOnes16bit(grid[cellOrder[cellOffset]]);
        this._candidateSelectionState[cellDepth] = null;
        if (this._debugLogger.enableStepLogs) {
          this._logSelectNextCandidate(
            'Adjusted by user:', cellOrder[cellOffset], value, count, cellDepth);
        }
      }
    }

    const nextCellDepth = this._updateCellOrder(
      cellDepth, cellOffset, count, grid);

    if (this._debugLogger.enableStepLogs) {
      if (nextCellDepth != cellDepth + 1) {
        this._debugLogger.log({
          loc: 'selectNextCandidate',
          msg: 'Found extra singles',
          args: {
            count: nextCellDepth - cellDepth - 1,
          },
          cells: cellOrder.subarray(cellDepth + 1, nextCellDepth),
        });
      }
    }

    return [cellOrder.subarray(cellDepth, nextCellDepth), value, count];
  }

  _updateCellOrder(cellDepth, cellOffset, count, grid) {
    const cellOrder = this._cellOrder;
    let frontOffset = cellDepth;

    // Swap cellOffset into the next position, so that it will be processed
    // next.
    [cellOrder[cellOffset], cellOrder[frontOffset]] =
      [cellOrder[frontOffset], cellOrder[cellOffset]];
    frontOffset++;
    cellOffset++;

    // If count was greater than 1, there were no singletons.
    if (count > 1) return frontOffset;

    // Move all singletons to the front of the cellOrder.
    const numCells = grid.length;

    // First skip past any values which are already at the front.
    while (cellOffset == frontOffset && cellOffset < numCells) {
      const v = grid[cellOrder[cellOffset++]];
      if (!(v & (v - 1))) frontOffset++;
    }

    // Find the rest of the values which are singletons.
    while (cellOffset < numCells) {
      const v = grid[cellOrder[cellOffset]];
      if (!(v & (v - 1))) {
        [cellOrder[cellOffset], cellOrder[frontOffset]] =
          [cellOrder[frontOffset], cellOrder[cellOffset]];
        frontOffset++;
      }
      cellOffset++;
    }

    return frontOffset;
  }

  _logSelectNextCandidate(msg, cell, value, count, cellDepth) {
    this._debugLogger.log({
      loc: 'selectNextCandidate',
      msg: msg,
      args: {
        cell: this._shape.makeCellIdFromIndex(cell),
        value: LookupTables.toValue(value),
        numOptions: count,
        cellDepth: cellDepth,
        state: this._candidateSelectionState[cellDepth],
      },
      cells: [cell],
    });
  }

  _selectBestCandidate(grid, cellOrder, cellDepth, isNewNode) {
    // If we have a special candidate state, then use that.
    // It will always be a singleton.
    if (this._candidateSelectionState[cellDepth] !== null) {
      const state = this._candidateSelectionState[cellDepth];
      this._candidateSelectionState[cellDepth] = null;
      return [cellOrder.indexOf(state.cell1), state.value, 1];
    }

    // Quick check - if the first value is a singleton, then just return without
    // the extra bookkeeping.
    {
      const firstValue = grid[cellOrder[cellDepth]];
      if ((firstValue & (firstValue - 1)) === 0) {
        return [cellDepth, firstValue, firstValue !== 0 ? 1 : 0];
      }
    }

    // Find the best cell to explore next.
    let cellOffset = this._selectBestCell(grid, cellOrder, cellDepth);
    const cell = cellOrder[cellOffset];

    // Find the next smallest value to try.
    // NOTE: We will always have a value because:
    //        - we would have returned earlier on domain wipeout.
    //        - we don't add to the stack on the final value in a cell.
    let values = grid[cell];
    let value = values & -values;
    let count = countOnes16bit(values);

    // Consider branching on a single digit within a house. Only to this if we
    // are:
    //  - Exploring this node for the first time. If we have backtracked here
    //    it is less likely that this will yield a better candidate.
    //  - Currently exploring a cell with more than 2 values.
    //  - Have non-zero backtrackTriggers (and thus score).
    if (isNewNode && count > 2 && this._backtrackTriggers[cell] > 0) {
      const score = this._backtrackTriggers[cell] / count;
      let result = this._findCandidatesByHouse(grid, score);
      if (result.score >= score) {
        count = 2;
        value = result.value;
        cellOffset = cellOrder.indexOf(result.cell0);
        this._candidateSelectionState[cellDepth] = result;
      }
    }

    return [cellOffset, value, count];
  }

  _selectBestCell(grid, cellOrder, cellDepth) {
    // Choose cells based on value count and number of backtracks it caused.
    // NOTE: The constraint handlers are written such that they detect domain
    // wipeouts (0 values), so we should never find them here. Even if they
    // exist, it just means we do a few more useless forced cell resolutions.
    // NOTE: If the scoring is more complicated, it can be useful
    // to do an initial pass to detect 1 or 0 value cells (!(v&(v-1))).

    const numCells = grid.length;
    const backtrackTriggers = this._backtrackTriggers;

    // Find the cell with the minimum score.
    let maxScore = -1;
    let bestOffset = 0;

    for (let i = cellDepth; i < numCells; i++) {
      const cell = cellOrder[i];
      const count = countOnes16bit(grid[cell]);
      // If we have a single value then just use it - as it will involve no
      // guessing.
      // NOTE: We could use more efficient check for count() < 1, but it's not
      // worth it as this only happens at most once per loop. The full count()
      // will have to occur anyway for every other iteration.
      if (count <= 1) {
        bestOffset = i;
        maxScore = -1;
        break;
      }

      let score = backtrackTriggers[cell] / count;

      if (score > maxScore) {
        bestOffset = i;
        maxScore = score;
      }
    }

    if (maxScore === 0) {
      // It's rare that maxScore is 0 since all backtrack triggers must be 0.
      // However, in this case we can run a special loop to find the cell with
      // the min count.
      //
      // Looping over the cells again is not a concern since this is rare. It is
      // better to take it out of the main loop.
      bestOffset = this._minCountCellIndex(grid, cellOrder, cellDepth);
    }

    return bestOffset;
  }

  // Find the cell index with the minimum score. Return the index into cellOrder.
  _minCountCellIndex(grid, cellOrder, cellDepth) {
    let minCount = 1 << 16;
    let bestOffset = 0;
    for (let i = cellDepth; i < grid.length; i++) {
      const count = countOnes16bit(grid[cellOrder[i]]);
      if (count < minCount) {
        bestOffset = i;
        minCount = count;
      }
    }
    return bestOffset;
  }

  _adjustForStepState(stepState, grid, cellOrder, cellDepth, cellOffset, value) {
    const step = stepState.step;
    const guide = stepState.stepGuides.get(step) || {};
    let adjusted = false;

    // If there is a cell guide, then use that.
    if (guide.cell) {
      const newCellOffset = cellOrder.indexOf(guide.cell, cellDepth);
      if (newCellOffset !== -1) {
        cellOffset = newCellOffset;
        adjusted = true;
      }
    }

    const cellValues = grid[cellOrder[cellOffset]];

    if (guide.value) {
      // Use the value from the guide.
      value = LookupTables.fromValue(guide.value);
      adjusted = true;
    } else if (guide.cell) {
      // Or if we had a guide cell then choose a value which is valid for that
      // cell.
      value = cellValues & -cellValues;
      adjusted = true;
    }

    return [cellOffset, value, adjusted];
  }

  _findCandidatesByHouse(grid, score) {
    const numCells = grid.length;

    // Add all handlers with cells which can potentially beat the current score.
    const minBt = Math.ceil(score * 2) | 0;
    const backtrackTriggers = this._backtrackTriggers;
    const handlerAccumulator = this._houseHandlerAccumulator;
    for (let i = 0; i < numCells; i++) {
      if (backtrackTriggers[i] >= minBt) {
        const v = grid[i];
        if (v & (v - 1)) {
          handlerAccumulator.addForCell(i);
        }
      }
    }

    // Find all candidates with exactly two values.
    let bestResult = {
      score: -1,
      value: 0,
      cell0: 0,
      cell1: 0,
    };
    while (!handlerAccumulator.isEmpty()) {
      const handler = handlerAccumulator.takeNext();
      const cells = handler.cells;
      const numCells = cells.length;

      let allValues = 0;
      let moreThanOne = 0;
      let moreThanTwo = 0;
      for (let i = 0; i < numCells; i++) {
        const v = grid[cells[i]];
        moreThanTwo |= moreThanOne & v;
        moreThanOne |= allValues & v;
        allValues |= v;
      }

      let exactlyTwo = moreThanOne & ~moreThanTwo;
      while (exactlyTwo) {
        let v = exactlyTwo & -exactlyTwo;
        exactlyTwo ^= v;
        const result = this._scoreHouseCandidateValue(grid, cells, v);
        if (result.score > bestResult.score) {
          bestResult = result;
        }
      }
    }

    return bestResult;
  }

  _scoreHouseCandidateValue(grid, cells, v) {
    let numCells = cells.length;
    let cell0 = 0;
    let cell1 = 0;
    for (let i = 0; i < numCells; i++) {
      if (grid[cells[i]] & v) {
        [cell0, cell1] = [cell1, cells[i]];
      }
    }

    let bt0 = this._backtrackTriggers[cell0];
    let bt1 = this._backtrackTriggers[cell1];
    // Make bt0 the larger of the two.
    // Also make cell0 the cell with the larger backtrack trigger, since cell0
    // is searched first. NOTE: This turns out ot be a bit faster, but means
    // we usually find the solution later in the search.
    if (bt0 < bt1) {
      [bt0, bt1] = [bt1, bt0];
      [cell0, cell1] = [cell1, cell0];
    }
    const score = bt0 / 2;  // max(bt[cell_i]) / numCells

    return {
      value: v,
      score: score,
      cell0: cell0,
      cell1: cell1,
    };
  }
}

SudokuSolver.HandlerAccumulator = class {
  // NOTE: This is intended to be created once, and reused.
  constructor(handlerSet) {
    this._handlers = handlerSet.getAll();
    this._ordinaryHandlers = handlerSet.getOrdinaryHandlerMap();
    this._auxHandlers = handlerSet.getAuxHandlerMap();
    this._exclusionHandlers = new Uint16Array(
      handlerSet.getExclusionHandlerMap());

    this._linkedList = new Int16Array(this._handlers.length);
    this._linkedList.fill(-2);  // -2 = Not in list.
    this._head = -1;  // -1 = null pointer.
    this._tail = -1;  // If list is empty, tail can be any value.
  }

  addForFixedCell(cell) {
    // Push exclusion handlers to the front of the queue.
    this._pushIndex(this._exclusionHandlers[cell]);
  }

  addAuxForCell(cell) {
    this._enqueueIndexes(this._auxHandlers[cell]);
  }

  addForCell(cell) {
    this._enqueueIndexes(this._ordinaryHandlers[cell]);
  }

  _enqueueIndexes(indexes) {
    const numHandlers = indexes.length;
    for (let j = 0; j < numHandlers; j++) {
      const i = indexes[j];
      if (this._linkedList[i] < -1) {
        if (this._head == -1) {
          this._head = i;
        } else {
          this._linkedList[this._tail] = i;
        }
        this._tail = i;
        this._linkedList[i] = -1;
      }
    }
  }

  _pushIndex(index) {
    if (this._linkedList[index] < -1) {
      if (this._head == -1) {
        this._tail = index;
      }
      this._linkedList[index] = this._head;
      this._head = index;
    }
  }

  clear() {
    const ll = this._linkedList;
    let head = this._head;
    while (head >= 0) {
      const newHead = ll[head];
      ll[head] = -2;
      head = newHead;
    }
    this._head = -1;
  }

  isEmpty() {
    return this._head == -1;
  }

  takeNext() {
    const oldHead = this._head;
    this._head = this._linkedList[oldHead];
    this._linkedList[oldHead] = -2;

    return this._handlers[oldHead];
  }
}

SudokuSolver.CellExclusions = class {
  constructor(handlerSet, shape) {
    this._cellExclusionSets = this.constructor._makeCellExclusionSets(
      handlerSet, shape);

    // Store an array version for fast iteration.
    // Sort the cells so they are in predictable order.
    this._cellExclusionArrays = (
      this._cellExclusionSets.map(c => new Uint8Array(c)));
    this._cellExclusionArrays.forEach(c => c.sort((a, b) => a - b));

    // Indexing of pairs:
    //   pairExclusions[(i << 8) | j] = [cells which are excluded by both i and j]
    this._pairExclusions = new Map();
    // Indexing of lists:
    //   listExclusions[obj] = [cells which are excluded by all cells in obj]
    //   obj must match exactly.
    this._listExclusions = new Map();
  }

  static _makeCellExclusionSets(handlerSet, shape) {
    const cellExclusionSets = [];
    for (let i = 0; i < shape.numCells; i++) {
      cellExclusionSets.push(new Set());
    }

    for (const h of handlerSet) {
      const exclusionCells = h.exclusionCells();
      for (const c of exclusionCells) {
        for (const d of exclusionCells) {
          if (c != d) cellExclusionSets[c].add(d);
        }
      }
    }

    return cellExclusionSets;
  }

  isMutuallyExclusive(cell1, cell2) {
    return this._cellExclusionSets[cell1].has(cell2);
  }

  getArray(cell) {
    return this._cellExclusionArrays[cell];
  }

  getPairExclusions(pairIndex) {
    return this._pairExclusions.get(pairIndex);
  }

  getListExclusions(cells) {
    return this._listExclusions.get(cells);
  }

  cacheCellTuples(cells) {
    const numCells = cells.length;

    for (let i = 0; i < numCells; i++) {
      for (let j = i + 1; j < numCells; j++) {
        this._cachePair(cells[i], cells[j]);
      }
    }

    this.cacheCellList(cells);
  }

  cacheCellList(cells) {
    const numCells = cells.length;

    // Find the intersection of all exclusions.
    let allCellExclusions = this._cellExclusionSets[cells[0]];
    for (let i = 1; i < numCells && allCellExclusions.size; i++) {
      allCellExclusions = setIntersection(
        allCellExclusions, this._cellExclusionSets[cells[i]]);
    }

    // Only add it if it's not empty.
    if (allCellExclusions.size) {
      this._listExclusions.set(cells, new Uint8Array(allCellExclusions));
    }
  }

  _cachePair(cell0, cell1) {
    const key = (cell0 << 8) | cell1;

    // Check if we've already cached the pair.
    if (this._pairExclusions.has(key)) return;

    // If we've cached the reverse order, then use that.
    const revKey = (cell1 << 8) | cell0;
    if (this._pairExclusions.has(revKey)) {
      this._pairExclusions.set(key, this._pairExclusions.get(revKey));
      return;
    }

    // Otherwise, calculate the intersection.
    const exclusionSet = setIntersection(
      this._cellExclusionSets[cell0],
      this._cellExclusionSets[cell1]);
    this._pairExclusions.set(key, new Uint8Array(exclusionSet));

    return;
  }
}

class LookupTables {
  static get = memoize((numValues) => {
    return new LookupTables(true, numValues);
  });

  static fromValue = (i) => {
    return 1 << (i - 1);
  };

  static fromValuesArray = (xs) => {
    let result = 0;
    for (const x of xs) {
      result |= this.fromValue(x);
    }
    return result;
  };

  static toValue(v) {
    return 32 - Math.clz32(v);
  };

  static maxValue(v) {
    return 32 - Math.clz32(v);
  };

  static minValue(v) {
    return 32 - Math.clz32(v & -v);
  };

  static toIndex(v) {
    return 31 - Math.clz32(v);
  };

  static toValuesArray(values) {
    let result = [];
    while (values) {
      let value = values & -values;
      values ^= value;
      result.push(LookupTables.toValue(value));
    }
    return result;
  }

  constructor(do_not_call, numValues) {
    if (!do_not_call) throw ('Use LookupTables.get(shape.numValues)');

    this.allValues = (1 << numValues) - 1;
    this.combinations = 1 << numValues;

    const combinations = this.combinations;

    this.sum = (() => {
      let table = new Uint8Array(combinations);
      for (let i = 1; i < combinations; i++) {
        // SUM is the value of the lowest set bit plus the sum  of the rest.
        table[i] = table[i & (i - 1)] + LookupTables.toValue(i & -i);
      }
      return table;
    })();

    // Combines min and max into a single integer:
    // Layout: [min: 8 bits, max: 8 bits]
    //
    // The extra bits allow these values to be summed to determine the total
    // of mins and maxs.
    //
    // NOTE: This is faster than calling LookupTables.minValue and
    // LookupTables.maxValue separately, but only if both are required.
    this.minMax8Bit = (() => {
      // Initialize the table with MAXs.
      const table = new Uint16Array(combinations);
      table[1] = LookupTables.toValue(1);
      for (let i = 2; i < combinations; i++) {
        // MAX is greater than the max when everything has been decreased by
        // 1.
        table[i] = 1 + table[i >> 1];
      }

      // Add the MINs.
      for (let i = 1; i < combinations; i++) {
        // MIN is the value of the last bit set.
        const min = LookupTables.toValue(i & -i);
        table[i] |= min << 8;
      }

      return table;
    })();

    // The maximum number of cells in a sum is 16 so that it can the count
    // can be stored in 4 bits. This is important for the layout of
    // isFixed in rangeInfo.
    this.MAX_CELLS_IN_SUM = 16;

    // Combines useful info about the range of numbers in a cell.
    // Designed to be summed, so that the aggregate stats can be found.
    // Layout: [isFixed: 4 bits, fixed: 8 bits, min: 8 bits, max: 8 bits]
    //
    // Sum of isFixed gives the number of fixed cells.
    // Sum of fixed gives the sum of fixed cells.
    // Min and max as a in minMax.
    this.rangeInfo = (() => {
      const table = new Uint32Array(combinations);
      for (let i = 1; i < combinations; i++) {
        const minMax = this.minMax8Bit[i];
        const fixed = countOnes16bit(i) == 1 ? LookupTables.toValue(i) : 0;
        const isFixed = fixed ? 1 : 0;
        table[i] = (isFixed << 24) | (fixed << 16) | minMax;
      }
      // If there are no values, set a high value for isFixed to indicate the
      // result is invalid. This is intended to be detectable after summing.
      table[0] = numValues << 24;
      return table;
    })();

    this.reverse = (() => {
      let table = new Uint16Array(combinations);
      for (let i = 0; i < combinations; i++) {
        let rev = 0;
        for (let j = 0; j < numValues; j++) {
          rev |= ((i >> j) & 1) << (numValues - 1 - j);
        }
        table[i] = rev;
      }
      return table;
    })();

    const NUM_BITS_BASE64 = 6;
    const keyArr = new Uint8Array(
      Base64Codec.lengthOf6BitArray(numValues * numValues));

    this.forBinaryKey = memoize((key) => {
      const table = new Uint16Array(combinations);
      const tableInv = new Uint16Array(combinations);

      keyArr.fill(0);
      Base64Codec.decodeTo6BitArray(key, keyArr);

      // Populate base cases, where there is a single value set.
      let keyIndex = 0;
      let vIndex = 0;
      for (let i = 0; i < numValues; i++) {
        for (let j = 0; j < numValues; j++) {
          const v = keyArr[keyIndex] & 1;
          table[1 << i] |= v << j;
          tableInv[1 << j] |= v << i;

          keyArr[keyIndex] >>= 1;
          if (++vIndex == NUM_BITS_BASE64) {
            vIndex = 0;
            keyIndex++;
          }
        }
      }

      // To fill in the rest, OR together all the valid settings for each value
      // set.
      for (let i = 1; i < combinations; i++) {
        table[i] = table[i & (i - 1)] | table[i & -i];
        tableInv[i] = tableInv[i & (i - 1)] | tableInv[i & -i];
      }
      return [table, tableInv];
    });
  }
}