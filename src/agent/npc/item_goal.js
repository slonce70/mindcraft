import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { itemSatisfied } from './utils.js';

const blacklist = [
    'coal_block',
    'iron_block',
    'gold_block',
    'diamond_block',
    'deepslate',
    'blackstone',
    'netherite',
    '_wood',
    'stripped_',
    'crimson',
    'warped',
    'dye'
]

class ItemNode {
    constructor(manager, wrapper, name) {
        this.manager = manager;
        this.wrapper = wrapper;
        this.name = name;
        this.type = '';
        this.source = null;
        this.prereq = null;
        this.recipe = [];
        this.fails = 0;
    }

    setRecipe(recipe) {
        this.type = 'craft';
        let size = 0;
        this.recipe = [];
        for (let [key, value] of Object.entries(recipe)) {
            if (this.manager.nodes[key] === undefined)
                this.manager.nodes[key] = new ItemWrapper(this.manager, this.wrapper, key);
            this.recipe.push({node: this.manager.nodes[key], quantity: value});
            size += value;
        }
        if (size > 4) {
            if (this.manager.nodes['crafting_table'] === undefined)
                this.manager.nodes['crafting_table'] = new ItemWrapper(this.manager, this.wrapper, 'crafting_table');
            this.prereq = this.manager.nodes['crafting_table'];
        }
        return this;
    }

    setCollectable(source=null, tool=null) {
        this.type = 'block';
        if (source)
            this.source = source;
        else
            this.source = this.name;
        if (tool) {
            if (this.manager.nodes[tool] === undefined)
                this.manager.nodes[tool] = new ItemWrapper(this.manager, this.wrapper, tool);
            this.prereq = this.manager.nodes[tool];
        }
        return this;
    }

    setSmeltable(source_item) {
        this.type = 'smelt';
        if (this.manager.nodes['furnace'] === undefined)
            this.manager.nodes['furnace'] = new ItemWrapper(this.manager, this.wrapper, 'furnace');
        this.prereq = this.manager.nodes['furnace'];

        if (this.manager.nodes[source_item] === undefined)
            this.manager.nodes[source_item] = new ItemWrapper(this.manager, this.wrapper, source_item);
        if (this.manager.nodes['coal'] === undefined)
            this.manager.nodes['coal'] = new ItemWrapper(this.manager, this.wrapper, 'coal');
        this.recipe = [
            {node: this.manager.nodes[source_item], quantity: 1},
            {node: this.manager.nodes['coal'], quantity: 1}
        ];
        return this;
    }

    setHuntable(animal_source) {
        this.type = 'hunt';
        this.source = animal_source;
        return this;
    }

    getChildren() {
        let children = [...this.recipe];
        if (this.prereq) {
            children.push({node: this.prereq, quantity: 1});
        }
        return children;
    }

    isReady() {
        for (let child of this.getChildren()) {
            if (!child.node.isDone(child.quantity)) {
                return false;
            }
        }
        return true;
    }

    isDone(quantity=1) {
        if (this.manager.goal.name === this.name)
            return false;
        return itemSatisfied(this.manager.agent.bot, this.name, quantity);
    }

    getDepth(q=1) {
        if (this.isDone(q)) {
            return 0;
        }
        let depth = 0;
        for (let child of this.getChildren()) {
            depth = Math.max(depth, child.node.getDepth(child.quantity));
        }
        return depth + 1;
    }

    getFails(q=1) {
        if (this.isDone(q)) {
            return 0;
        }
        let fails = 0;
        for (let child of this.getChildren()) {
            fails += child.node.getFails(child.quantity);
        }
        return fails + this.fails;
    }

    getNext(q=1) {
        if (this.isDone(q))
            return null;
        if (this.isReady())
            return {node: this, quantity: q};
        for (let child of this.getChildren()) {
            let res = child.node.getNext(child.quantity);
            if (res)
                return res;
        }
        return null;
    }

    async execute(quantity=1) {
        if (!this.isReady()) {
            this.fails += 1;
            return;
        }
        let inventory = world.getInventoryCounts(this.manager.agent.bot);
        let init_quantity = inventory[this.name] || 0;
        if (this.type === 'block') {
            await skills.collectBlock(this.manager.agent.bot, this.source, quantity, this.manager.agent.npc.getBuiltPositions());
        } else if (this.type === 'smelt') {
            let to_smelt_name = this.recipe[0].node.name;
            let to_smelt_quantity = Math.min(quantity, inventory[to_smelt_name] || 1);
            await skills.smeltItem(this.manager.agent.bot, to_smelt_name, to_smelt_quantity);
        } else if (this.type === 'hunt') {
            for (let i=0; i<quantity; i++) {
                res = await skills.attackNearest(this.manager.agent.bot, this.source);
                if (!res || this.manager.agent.bot.interrupt_code)
                    break;
            }
        } else if (this.type === 'craft') {
            await skills.craftRecipe(this.manager.agent.bot, this.name, quantity);
        }
        let final_quantity = world.getInventoryCounts(this.manager.agent.bot)[this.name] || 0;
        if (final_quantity <= init_quantity) {
            this.fails += 1;
        }
        return final_quantity > init_quantity;
    }
}

class ItemWrapper {
    constructor(manager, parent, name) {
        this.manager = manager;
        this.name = name;
        this.parent = parent;
        this.methods = [];

        let blacklisted = false;
        for (let match of blacklist) {
            if (name.includes(match)) {
                blacklisted = true;
                break;
            }
        }

        if (!blacklisted && !this.containsCircularDependency()) {
            this.createChildren();
        }
    }

    add_method(method) {
        for (let child of method.getChildren()) {
            if (child.node.methods.length === 0)
                return;
        }
        this.methods.push(method);
    }

    createChildren() {
        let recipes = mc.getItemCraftingRecipes(this.name).map(([recipe, craftedCount]) => recipe);
        if (recipes) {
            for (let recipe of recipes) {
                let includes_blacklisted = false;
                for (let ingredient in recipe) {
                    for (let match of blacklist) {
                        if (ingredient.includes(match)) {
                            includes_blacklisted = true;
                            break;
                        }
                    }
                    if (includes_blacklisted) break;
                }
                if (includes_blacklisted) continue;
                this.add_method(new ItemNode(this.manager, this, this.name).setRecipe(recipe))
            }
        }

        let block_sources = mc.getItemBlockSources(this.name);
        if (block_sources.length > 0 && this.name !== 'torch' && !this.name.includes('bed')) {  // Do not collect placed torches or beds
            for (let block_source of block_sources) {
                if (block_source === 'grass_block') continue;  // Dirt nodes will collect grass blocks
                let tool = mc.getBlockTool(block_source);
                this.add_method(new ItemNode(this.manager, this, this.name).setCollectable(block_source, tool));
            }
        }

        let smeltingIngredient = mc.getItemSmeltingIngredient(this.name);
        if (smeltingIngredient) {
            this.add_method(new ItemNode(this.manager, this, this.name).setSmeltable(smeltingIngredient));
        }

        let animal_source = mc.getItemAnimalSource(this.name);
        if (animal_source) {
            this.add_method(new ItemNode(this.manager, this, this.name).setHuntable(animal_source));
        }
    }

    containsCircularDependency() {
        let p = this.parent;
        while (p) {
            if (p.name === this.name) {
                return true;
            }
            p = p.parent;
        }
        return false;
    }

    getBestMethod(q=1) {
        let best_cost = -1;
        let best_method = null;
        for (let method of this.methods) {
            let cost = method.getDepth(q) + method.getFails(q);
            if (best_cost == -1 || cost < best_cost) {
                best_cost = cost;
                best_method = method;
            }
        }
        return best_method
    }

    isDone(q=1) {
        if (this.methods.length === 0)
            return false;
        return this.getBestMethod(q).isDone(q);
    }

    getDepth(q=1) {
        if (this.methods.length === 0)
            return 0;
        return this.getBestMethod(q).getDepth(q);
    }

    getFails(q=1) {
        if (this.methods.length === 0)
            return 0;
        return this.getBestMethod(q).getFails(q);
    }

    getNext(q=1) {
        if (this.methods.length === 0)
            return null;
        return this.getBestMethod(q).getNext(q);
    }
}

export class ItemGoal {
    constructor(agent) {
        this.agent = agent;
        this.goal = null;
        this.nodes = {};
        this.failed = [];
        this._currentPlan = null;
    }

    async planResourceGathering(item_name, item_quantity=1) {
        // First check if we already have the item in known locations
        const knownLocations = this._getKnownLocations(item_name);
        if (knownLocations.length > 0) {
            this._currentPlan = {
                type: 'known_location',
                locations: this._optimizeGatheringRoute(knownLocations),
                requirements: new Map(),
                tools: this._getRequiredTools(item_name)
            };
            return true;
        }

        // If not found in known locations, plan gathering from scratch
        const requirements = this._gatherRequirements(item_name, item_quantity);
        if (requirements.size === 0) return false;

        const locations = this._findResourceLocations(requirements);
        if (locations.length === 0) return false;

        this._currentPlan = {
            type: 'gather_new',
            locations: this._optimizeGatheringRoute(locations),
            requirements,
            tools: this._getRequiredTools(item_name)
        };
        return true;
    }

    _getKnownLocations(item_name) {
        const locations = [];
        const memory = this.agent.memory_bank.getJson();
        
        // Parse memory entries for relevant locations
        for (const [key, value] of Object.entries(memory)) {
            const keyLower = key.toLowerCase();
            const itemLower = item_name.toLowerCase();
            
            // Check if memory entry contains item name
            if (keyLower.includes(itemLower)) {
                if (Array.isArray(value) && value.length === 3) {
                    locations.push({
                        x: value[0],
                        y: value[1],
                        z: value[2],
                        type: item_name,
                        source: 'memory'
                    });
                }
            }
        }
        
        return locations;
    }

    _getRequiredTools(item_name) {
        const tools = new Set();
        const mcData = require('minecraft-data')(this.agent.bot.version);
        
        // Check if item requires specific tool
        if (item_name.includes('diamond')) {
            tools.add('iron_pickaxe');
        } else if (item_name.includes('iron')) {
            tools.add('stone_pickaxe');
        }
        
        // Add any additional tool requirements based on block type
        const block = mcData.blocksByName[item_name];
        if (block) {
            const tool = this.agent.bot.pathfinder.getToolFor(block);
            if (tool) tools.add(tool.name);
        }
        
        return Array.from(tools);
    }

    async executeNext(item_name, item_quantity=1) {
        const bot = this.agent.bot;
        if (!bot) return false;

        // Check if we already have the item
        const itemCount = bot.inventory.count(item_name);
        if (itemCount >= item_quantity) {
            return true;
        }

        // Get required tools first
        const requiredTools = await this._getRequiredTools(item_name);
        for (const tool of requiredTools) {
            if (!bot.inventory.findInventoryItem(tool)) {
                console.log(`Need ${tool} to collect ${item_name}`);
                await this.executeNext(tool, 1);
            }
        }

        // Try to craft the item if it's craftable
        const recipe = bot.recipesFor(item_name)[0];
        if (recipe) {
            // Get all ingredients
            for (const ingredient of recipe.ingredients) {
                const needed = ingredient.count;
                const have = bot.inventory.count(ingredient.name);
                if (have < needed) {
                    await this.executeNext(ingredient.name, needed - have);
                }
            }
            // Try crafting
            try {
                await bot.craft(recipe, 1);
                return true;
            } catch (err) {
                console.log(`Failed to craft ${item_name}:`, err.message);
            }
        }

        // If we can't craft or crafting failed, try to collect from world
        return await this._collectResource(item_name, item_quantity);
    }

    async _collectResource(itemName, quantity) {
        const bot = this.agent.bot;
        let collected = 0;
        const startY = Math.floor(bot.entity.position.y);

        // Try different Y levels if needed (for ores)
        const yLevels = this._getOptimalYLevels(itemName);
        
        for (const targetY of yLevels) {
            // Move to target Y level if needed
            if (Math.abs(bot.entity.position.y - targetY) > 3) {
                await this._mineToLevel(targetY);
            }

            // Search in expanding radius
            for (let radius = 16; radius <= 64; radius += 16) {
                if (collected >= quantity) break;

                const blocks = bot.findBlocks({
                    matching: itemName,
                    maxDistance: radius,
                    count: 64
                });

                if (blocks.length > 0) {
                    for (const pos of blocks) {
                        if (collected >= quantity) break;
                        
                        const block = bot.blockAt(pos);
                        if (!block) continue;

                        try {
                            await bot.pathfinder.goto(pos);
                            await bot.dig(block);
                            collected++;
                            
                            // Wait for drops to be collected
                            await new Promise(resolve => setTimeout(resolve, 250));
                        } catch (err) {
                            console.log(`Failed to collect ${itemName}:`, err.message);
                            continue;
                        }
                    }
                }
            }
        }

        return collected > 0;
    }

    _getOptimalYLevels(itemName) {
        // Default to current Y level
        const currentY = Math.floor(this.agent.bot.entity.position.y);
        
        // Optimal Y levels for different resources
        const yLevelMap = {
            'diamond_ore': [11],
            'iron_ore': [16],
            'coal_ore': [95],
            'gold_ore': [32],
            'redstone_ore': [13],
            'lapis_ore': [13],
            'copper_ore': [48],
            'emerald_ore': [32]
        };

        // For ores, use optimal levels
        if (itemName.endsWith('_ore')) {
            return yLevelMap[itemName] || [currentY];
        }

        // For trees and surface resources, stay near surface
        if (['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'].includes(itemName)) {
            return [64]; // Surface level
        }

        // Default to current level
        return [currentY];
    }

    async _mineToLevel(targetY) {
        const bot = this.agent.bot;
        const pos = bot.entity.position;
        if (Math.floor(pos.y) === targetY) return;

        // Dig down or climb up safely
        const direction = pos.y > targetY ? 'down' : 'up';
        while (Math.floor(bot.entity.position.y) !== targetY) {
            try {
                const currentBlock = direction === 'down' 
                    ? bot.blockAt(pos.offset(0, -1, 0))
                    : bot.blockAt(pos.offset(0, 2, 0));
                
                if (!currentBlock || currentBlock.name === 'air') {
                    if (direction === 'up') {
                        // Place blocks to climb up
                        await this._placeBlock();
                    }
                } else {
                    // Check for hazards
                    const aboveBlock = bot.blockAt(pos.offset(0, 2, 0));
                    if (aboveBlock && (aboveBlock.name === 'water' || aboveBlock.name === 'lava')) {
                        console.log('Detected hazard, finding alternative path');
                        break;
                    }
                    
                    // Dig the block
                    await bot.dig(currentBlock);
                }
                
                // Move safely
                if (direction === 'down') {
                    bot.setControlState('sneak', true);
                } else {
                    bot.setControlState('jump', true);
                }
                await new Promise(resolve => setTimeout(resolve, 250));
                bot.clearControlStates();
            } catch (err) {
                console.log('Error while mining to level:', err.message);
                break;
            }
        }
    }

    _gatherRequirements(item_name, quantity, memo = new Map()) {
        if (memo.has(item_name)) {
            const existing = memo.get(item_name);
            existing.quantity += quantity;
            return [];
        }

        const requirements = [{
            name: item_name,
            quantity: quantity
        }];
        memo.set(item_name, requirements[0]);

        const node = this.nodes[item_name];
        if (!node) return requirements;

        if (node.prereq) {
            requirements.push(...this._gatherRequirements(node.prereq.name, 1, memo));
        }

        if (node.recipe) {
            for (const ingredient of node.recipe) {
                requirements.push(...this._gatherRequirements(ingredient.node.name, ingredient.quantity, memo));
            }
        }

        return requirements;
    }

    async _findResourceLocations(resources) {
        const locations = [];
        for (const resource of resources) {
            if (this.nodes[resource.name]) {
                const node = this.nodes[resource.name];
                if (node.type === 'block') {
                    const nearestBlocks = world.getNearestBlocks(this.agent.bot, node.source || node.name, 64, 5);
                    for (const block of nearestBlocks) {
                        locations.push({
                            resource: {
                                ...resource,
                                type: node.type,
                                source: node.source
                            },
                            position: block.position
                        });
                    }
                }
            }
        }
        return locations;
    }

    _optimizeGatheringRoute(locations) {
        if (!locations.length) return [];
        
        const optimized = [locations[0]];
        const remaining = locations.slice(1);
        const botPos = this.agent.bot.entity.position;
        
        while (remaining.length) {
            const lastPos = optimized[optimized.length - 1].position;
            let nearestIdx = 0;
            let nearestDist = Infinity;
            
            for (let i = 0; i < remaining.length; i++) {
                const dist = this._distance(lastPos, remaining[i].position);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = i;
                }
            }
            
            optimized.push(remaining[nearestIdx]);
            remaining.splice(nearestIdx, 1);
        }
        
        return optimized;
    }

    _distance(pos1, pos2) {
        return Math.sqrt(
            Math.pow(pos2.x - pos1.x, 2) +
            Math.pow(pos2.y - pos1.y, 2) +
            Math.pow(pos2.z - pos1.z, 2)
        );
    }

    async _executeNode(node, quantity) {
        if (!node.isReady()) {
            node.fails += 1;
            return;
        }
        let inventory = world.getInventoryCounts(this.agent.bot);
        let init_quantity = inventory[node.name] || 0;
        if (node.type === 'block') {
            await skills.collectBlock(this.agent.bot, node.source, quantity, this.agent.npc.getBuiltPositions());
        } else if (node.type === 'smelt') {
            let to_smelt_name = node.recipe[0].node.name;
            let to_smelt_quantity = Math.min(quantity, inventory[to_smelt_name] || 1);
            await skills.smeltItem(this.agent.bot, to_smelt_name, to_smelt_quantity);
        } else if (node.type === 'hunt') {
            for (let i=0; i<quantity; i++) {
                res = await skills.attackNearest(this.agent.bot, node.source);
                if (!res || this.agent.bot.interrupt_code)
                    break;
            }
        } else if (node.type === 'craft') {
            await skills.craftRecipe(this.agent.bot, node.name, quantity);
        }
        let final_quantity = world.getInventoryCounts(this.agent.bot)[node.name] || 0;
        if (final_quantity <= init_quantity) {
            node.fails += 1;
        }
        return final_quantity > init_quantity;
    }
}
