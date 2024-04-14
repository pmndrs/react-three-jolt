//this is a holder for common commands and their buttons

export const commonCommands = {
    moveForward: {
        keys: ['w', 'W'],
        buttons: [12],
    },
    moveBackward: {
        keys: ['s', 'S'],
        buttons: [13],
    },
    moveLeft: {
        keys: ['a', 'A'],
        buttons: [14],
    },
    moveRight: {
        keys: ['d', 'D'],
        buttons: [15],
    },
    jump: {
        keys: [' '],
        buttons: [0],
    },
    crouch: {
        keys: ['Control', 'C', 'c'],
        buttons: [1],
    },
    run: {
        keys: ['Shift'],
        buttons: [10],
    },
    fire: {
        keys: ['Mouse0'],
        buttons: [7],
    },
    // special version of fire for asteroid type games (Space)
    spaceFire: {
        keys: [' ', 'Space', 'Mouse0'],
        buttons: [7],
    },
};

export type VectorPreset = {
    forward: {
        keys: string[];
        buttons: number[];
    };
    backward: {
        keys: string[];
        buttons: number[];
    };
    left: {
        keys: string[];
        buttons: number[];
    };
    right: {
        keys: string[];
        buttons: number[];
    };
};

// presets for the VectorCommand
export const vectorPresets = {
    move: {
        forward: {
            keys: ['w', 'W', 'ArrowUp'],
            buttons: [12],
            orientation: -1,
        },
        backward: {
            keys: ['s', 'S', 'ArrowDown'],
            buttons: [13],
            orientation: 1,
        },
        left: {
            keys: ['a', 'A', 'ArrowLeft'],
            buttons: [14],
            orientation: -1,
        },
        right: {
            keys: ['d', 'D', 'ArrowRight'],
            buttons: [15],
            orientation: 1,
        },
        axis: [0, 1],
    },
    look: {
        up: {
            keys: ['ArrowUp'],
            buttons: [12],
            orientation: -1,
        },
        down: {
            keys: ['ArrowDown'],
            buttons: [13],
            orientation: 1,
        },
        left: {
            keys: ['ArrowLeft'],
            buttons: [14],
            orientation: -1,
        },
        right: {
            keys: ['ArrowRight'],
            buttons: [15],
            orientation: 1,
        },
        axis: [2, 3],
    },
    race: {
        forward: {
            keys: ['w', 'ArrowUp'],
            buttons: [7],
            orientation: -1,
        },
        backward: {
            keys: ['s', 'ArrowDown'],
            buttons: [6],
            orientation: 1,
        },
        left: {
            keys: ['a', 'ArrowLeft'],
            buttons: [14],
            orientation: -1,
        },
        right: {
            keys: ['d', 'ArrowRight'],
            buttons: [15],
            orientation: -1,
        },
    },
};
