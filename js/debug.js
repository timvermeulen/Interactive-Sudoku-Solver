loadJSFile('js/solver/engine.js');
loadJSFile('js/solver/handlers.js');
loadJSFile('data/killers.js');
loadJSFile('data/jigsaw_layouts.js');
loadJSFile('data/invalid_jigsaw_layouts.js');

var TEST_TIMEOUT_MS = 1000;

const loadInput = (input) => {
  let puzzle = EXAMPLES[input];
  if (puzzle) input = puzzle.input;
  constraintManager.loadFromText(input);
}

const getShortSolution = () => {
  return toShortSolution(grid.getSolutionValues());
};

const toShortSolution = (valueIds) => {
  let result = new Array(81);
  const DEFAULT_VALUE = '.';
  result.fill(DEFAULT_VALUE);

  for (const valueId of valueIds) {
    let {cell, value} = parseValueId(valueId);
    if (result[cell] != DEFAULT_VALUE) throw('Too many solutions per cell.');
    result[cell] = value;
  }
  return result.join('');
}

const arrayEquals = (a, b) => {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

const puzzleFromCfg = (puzzleCfg) => {
  let puzzleStr, solution, name='';
  if (Array.isArray(puzzleCfg)) {
    [puzzleStr, solution] = puzzleCfg;
  } else {
    puzzleStr = puzzleCfg;
  }
  puzzle = EXAMPLES[puzzleStr];
  if (!puzzle) {
    puzzle = {input: puzzleStr, solution: solution};
  }

  return [puzzleStr, puzzle];
};

const runFnWithChecks = async (puzzles, fn, onFailure) => {
  const sumObjectValues = (a, b) => {
    let result = {...a};
    for (const [k, v] of Object.entries(b)) {
      if (!v) continue;
      if (!result[k]) result[k] = 0;
      result[k] += v;
    }
    return result;
  };

  let numFailures = 0;
  const failTest = (name, puzzle, result) => {
    numFailures++;
    if (onFailure) {
      onFailure();
    } else {
      console.log('Test failed: ' + (name || puzzle.input));
      console.log('Expected', puzzle.solution);
      console.log('Got     ', result);
      throw('Test failed: ' + name);
    }
  };

  let state;
  const stateHandler = (s) => { state = s; };

  let solutions = [];
  let rows = [];
  let total = {};
  for (const puzzleCfg of puzzles) {
    const [name, puzzle] = puzzleFromCfg(puzzleCfg);

    // Set up solver.
    const constraint = SudokuConstraint.fromText(puzzle.input);
    const solver = await SudokuBuilder.buildInWorker(constraint, stateHandler);

    // Log a fixed string so the progress gets collapsed to a single line.
    // Do this after the worker has started to ensure a nice output.
    console.log('solving...');

    // Start solver with optional timeout.
    let resultPromise = fn(solver);
    if (TEST_TIMEOUT_MS) {
      resultPromise = withDeadline(
        resultPromise, TEST_TIMEOUT_MS,
        `Solver timed out (${TEST_TIMEOUT_MS}ms)`);
    }

    // Wait for solver.
    let result;
    try {
      result = await resultPromise;
    } catch(e) {
      failTest(name, puzzle, e);
    } finally {
      solver.terminate();
    }

    if (result !== undefined) {
      let shortSolution;
      if (Array.isArray(result)) {
        shortSolution = toShortSolution(result);
        solutions.push(shortSolution);
      } else {
        solutions.push(null);
      }
      const resultToCheck = shortSolution || result;

      if (puzzle.solution !== undefined) {
        // We want to test the result.

        if (!puzzle.solution) {
          // Expect no solution.
          if (result) {
            failTest(name, puzzle, resultToCheck);
          }
        } else {
          // Expect a solution.
          if (!result || resultToCheck != puzzle.solution) {
            failTest(name, puzzle, resultToCheck);
          }
        }
      }
    }

    let row = {name: name, ...state.counters, timeMs: state.timeMs};
    rows.push(row);
    total = sumObjectValues(total, row);
    total.name = 'Total';
  }

  rows.total = total;
  console.table(rows);

  if (numFailures > 0) {
    console.error(numFailures + ' failures');
  }

  return solutions;
};

const runAllWithChecks = (puzzles, onFailure) => {
  return runFnWithChecks(puzzles, async (solver) => {
    const result = await solver.nthSolution(0);
    await solver.nthSolution(1); // Try to find a second solution to prove uniqueness.
    return result;
  }, onFailure);
};

const runValidateLayout = (cases, onFailure) => {
  return runFnWithChecks(cases, (solver) => {
    return solver.validateLayout();
  }, onFailure);
}

const runValidateLayoutTests = (onFailure) => {
  const cases = [].concat(
    VALID_JIGSAW_LAYOUTS.slice(0, 50),
    EASY_INVALID_JIGSAW_LAYOUTS);
  runValidateLayout(cases, onFailure);
};

const runTestCases = (onFailure) => {
  runAllWithChecks([
    'Thermosudoku',
    'Classic sudoku',
    'Classic sudoku, hard',
    'Anti-knights move',
    'Killer sudoku',
    'Sudoku X',
    'Anti-knight Anti-king',
    'Anti-knight, Anti-consecutive',
    'Arrow sudoku',
    'Arrow killer sudoku',
    'Kropki sudoku',
    'Little killer',
    'Little killer 2',
    'Sandwich sudoku',
    'German whispers',
    'Palindromes',
    'Jigsaw',
  ], onFailure);
};

const runAll = (puzzles, onFailure) => {
  runAllWithChecks(puzzles, onFailure);
};

const printGrid = (grid) => {
  const matrix = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    matrix.push(grid.slice(i*GRID_SIZE, (i+1)*GRID_SIZE));
  }
  console.table(matrix);
}

const showCellIndex = () => {
  infoOverlay.setValues([...Array(NUM_CELLS).keys()]);
};