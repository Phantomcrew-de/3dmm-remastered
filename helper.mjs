export { rotStepsFromDeg };


    function rotStepsFromDeg(deg) {
      const d = +deg;
      if (d === 90) return 1;
      if (d === 180) return 2;
      if (d === 270) return 3;
      return 0;
    }