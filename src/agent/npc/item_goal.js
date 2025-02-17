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
        const plan = {
            steps: [],
            totalDistance: 0,
            estimatedTime: 0
        };

        const requirements = this._gatherRequirements(item_name, item_quantity);
        
        const inventory = world.getInventoryCounts(this.agent.bot);
        
        const needed = requirements.filter(req => {
            const inInventory = inventory[req.name] || 0;
            return inInventory < req.quantity;
        });

        const resourceLocations = await this._findResourceLocations(needed);

        const optimizedRoute = this._optimizeGatheringRoute(resourceLocations);
        
        for (const location of optimizedRoute) {
            const toolRequired = mc.getBlockTool(location.resource.source || location.resource.name);
            if (toolRequired && !inventory[toolRequired]) {
                plan.steps.push({
                    type: 'craft',
                    item: toolRequired,
                    quantity: 1,
                    priority: 'high'
                });
            }
            
            plan.steps.push({
                type: location.resource.type,
                item: location.resource.name,
                quantity: location.resource.quantity,
                position: location.position,
                priority: toolRequired ? 'normal' : 'high'
            });
        }

        return plan;
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

    async executeNext(item_name, item_quantity=1) {
        if (!this._currentPlan || this._currentPlan.targetItem !== item_name) {
            this._currentPlan = await this.planResourceGathering(item_name, item_quantity);
            this._currentPlan.targetItem = item_name;
            this._currentPlan.currentStep = 0;
        }

        if (this._currentPlan && this._currentPlan.steps.length > this._currentPlan.currentStep) {
            const step = this._currentPlan.steps[this._currentPlan.currentStep];
            this._currentPlan.currentStep++;
            
            if (this.nodes[step.item] === undefined) {
                this.nodes[step.item] = new ItemWrapper(this, null, step.item);
            }
            this.goal = this.nodes[step.item];
            
            let next_info = this.goal.getNext(step.quantity);
            if (!next_info) {
                console.log(`Invalid item goal ${this.goal.name}`);
                return false;
            }
            
            if (step.position) {
                await this.agent.actions.runAction('itemGoal:collect', async () => {
                    await skills.collectBlock(this.agent.bot, step.item, step.quantity, [], step.position);
                });
            } else {
                return await this._executeNode(next_info.node, next_info.quantity);
            }
        }
        
        if (!this.nodes[item_name]) {
            this.nodes[item_name] = new ItemWrapper(this, null, item_name);
        }
        this.goal = this.nodes[item_name];
        
        let next_info = this.goal.getNext(item_quantity);
        if (!next_info) {
            console.log(`Invalid item goal ${this.goal.name}`);
            return false;
        }
        
        return await this._executeNode(next_info.node, next_info.quantity);
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
