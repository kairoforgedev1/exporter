import { createAsset } from 'pixi-svelte';

import img from './character.png';
import rawAtlas from './character.atlas?raw';
import CHARACTER from './character.json';

export default createAsset({
	img,
	rawAtlas,
	spines: {
		CHARACTER,
	},
});
