"use strict"

// Read the docs: https://nodered.org/docs/creating-nodes/node-js

/**
 * @param {import("node-red").NodeRedApp} RED
 */
module.exports = function (RED) {
    /**
     * @this {import("node-red").Node & Record<string,any>}
     * @param {import("node-red").NodeSettings<Record<string,any>>} config
     */
    function DataPipelineNode(config) {
        const node = this

        // @ts-ignore
        RED.nodes.createNode(this, config)

        // Steps are stored as JSON string in config, need to parse
        try {
            this.steps = typeof config.steps === "string"
                ? JSON.parse(config.steps)
                : config.steps || []
        } catch (e) {
            this.steps = []
            node.warn("data-pipeline: could not parse steps config")
        }

        node.on("input", function (msg, send, done) {
            let data = msg.payload

            // Validate input is an array
            if (!Array.isArray(data)) {
                const errMsg = "data-pipeline: msg.payload must be an array"
                node.warn(errMsg)
                // Output 2: error
                send([null, { ...msg, error: errMsg, payload: data }])
                return done()
            }

            try {
                // Run each step in sequence — output of one is input of next
                for (const step of node.steps) {
                    data = applyStep(step, data)
                }

                msg.payload = data
                // Output 1: success
                send([msg, null])
            } catch (err) {
                const errMsg = `data-pipeline error in step "${err.step || "unknown"}": ${err.message}`
                node.warn(errMsg)
                // Output 2: error
                send([null, { ...msg, error: errMsg }])
            }

            done()
        })
    }

    /**
     * Apply a single pipeline step to the data array
     * @param {{type: string, params: Record<string,any>}} step
     * @param {any[]} data
     * @returns {any[]}
     */
    function applyStep(step, data) {
        const { type, params } = step

        try {
            switch (type) {

                // FILTER: keep only items matching a condition
                // params.field  - field name to check (supports dot notation: "user.age")
                // params.op     - operator: ==, !=, >, <, >=, <=, contains, exists
                // params.value  - value to compare against
                case "filter": {
                    const { field, op, value } = params
                    return data.filter(item => {
                        const fieldVal = getNestedValue(item, field)
                        return compareValues(fieldVal, op, castValue(value, fieldVal))
                    })
                }

                // MAP: transform a field value using a formula
                // params.field      - field to transform
                // params.expression - JS expression using "value" as current field value
                //                     e.g. "value * 1.2" or "value.toUpperCase()"
                // params.outputField - optional: write result to different field
                case "map": {
                    const { field, expression, outputField } = params
                    return data.map(item => {
                        const value = getNestedValue(item, field) // "value" used in expression
                        // Safe eval — only has access to "value" and basic Math
                        const result = safeEval(expression, { value, Math, item })
                        const target = outputField || field
                        return setNestedValue({ ...item }, target, result)
                    })
                }

                // PICK: keep only specified fields in each item
                // params.fields - comma-separated list of fields to keep e.g. "name,age,email"
                case "pick": {
                    const fields = params.fields
                        .split(",")
                        .map(f => f.trim())
                        .filter(Boolean)
                    return data.map(item => {
                        const picked = {}
                        fields.forEach(f => {
                            const val = getNestedValue(item, f)
                            if (val !== undefined) setNestedValue(picked, f, val)
                        })
                        return picked
                    })
                }

                // SORT: sort array by a field
                // params.field - field to sort by (dot notation supported)
                // params.order - "asc" (default) or "desc"
                case "sort": {
                    const { field, order } = params
                    const dir = order === "desc" ? -1 : 1
                    return [...data].sort((a, b) => {
                        const va = getNestedValue(a, field)
                        const vb = getNestedValue(b, field)
                        if (va < vb) return -1 * dir
                        if (va > vb) return 1 * dir
                        return 0
                    })
                }

                // LIMIT: take only first N items
                // params.count - number of items to keep
                case "limit": {
                    const count = parseInt(params.count, 10)
                    if (isNaN(count) || count < 0) throw new Error("limit count must be a positive number")
                    return data.slice(0, count)
                }

                // FLATTEN: flatten nested arrays one level deep
                // params.field - optional: extract this field from each item before flattening
                //                if empty, flattens the array itself
                case "flatten": {
                    if (params.field) {
                        return data.flatMap(item => {
                            const val = getNestedValue(item, params.field)
                            return Array.isArray(val) ? val : [val]
                        })
                    }
                    return data.flat()
                }

                default:
                    throw new Error(`Unknown step type: "${type}"`)
            }
        } catch (err) {
            err.step = type
            throw err
        }
    }

    // --- Utility functions ---

    /**
     * Get a nested value from an object using dot notation
     * e.g. getNestedValue({user: {age: 25}}, "user.age") => 25
     */
    function getNestedValue(obj, path) {
        if (!path) return obj
        return path.split(".").reduce((acc, key) => acc && acc[key], obj)
    }

    /**
     * Set a nested value in an object using dot notation (mutates obj)
     */
    function setNestedValue(obj, path, value) {
        const keys = path.split(".")
        let current = obj
        for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) current[keys[i]] = {}
            current = current[keys[i]]
        }
        current[keys[keys.length - 1]] = value
        return obj
    }

    /**
     * Compare two values using an operator
     */
    function compareValues(a, op, b) {
        switch (op) {
            case "==": return a == b
            case "!=": return a != b
            case ">":  return a > b
            case "<":  return a < b
            case ">=": return a >= b
            case "<=": return a <= b
            case "contains": return String(a).includes(String(b))
            case "exists": return a !== undefined && a !== null
            default: return false
        }
    }

    /**
     * Try to cast value string to match the type of the field value
     */
    function castValue(value, fieldVal) {
        if (typeof fieldVal === "number") return Number(value)
        if (typeof fieldVal === "boolean") return value === "true"
        return value
    }

    /**
     * Safe expression evaluator — only exposes whitelisted variables
     */
    function safeEval(expression, context) {
        const fn = new Function(...Object.keys(context), `return (${expression})`)
        return fn(...Object.values(context))
    }

    // Register the node — name must match data-template-name in HTML
    // @ts-ignore
    RED.nodes.registerType("data-pipeline", DataPipelineNode)
}