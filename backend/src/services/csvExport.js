function toCSV(data) {
    if (!data || !data.length) return '';
    const headers = Object.keys(data[0]).join(',');
    const rows = data.map(row => 
        Object.values(row).map(val => 
            \"\ + (val !== null && val !== undefined ? val.toString().replace(/"/g, '""') : '') + \"\
        ).join(',')
    );
    return [headers, ...rows].join('\n');
}
module.exports = { toCSV };
